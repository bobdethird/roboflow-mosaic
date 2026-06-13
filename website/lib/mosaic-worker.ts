// Mosaic Web Worker: keeps all heavy, blocking work off the main thread so the
// app stays responsive with thousands of photos.
//
// The shared photo library is hydrated as signatures + thumbnail URLs (no image
// bytes up front). On generate it (1) matches every cell to its best tile (pure
// CPU), (2) fetches the *unique* placed tiles' thumbnails from the public
// Storage CDN in parallel — painting progressively as they arrive — and (3)
// returns the finished frame as a transferable ImageBitmap. Decoded tiles are
// cached across generates (keyed by id, fixed size regardless of density) so
// re-running at a new resolution reuses them instantly instead of re-fetching.

import { SIGNATURE_GRID, drawPolygonCell, type Grid } from "./mosaic"
import type {
  HydrateItem,
  WorkerRequest,
  WorkerResponse,
} from "./mosaic-protocol"

// Minimal view of the worker global so we don't need the conflicting
// "webworker" TS lib alongside "dom".
const scope = self as unknown as {
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void
}

// Longest side decoded when painting the small base-canvas cells.
const BASE_TILE_MAX = 128
// Minimum gap between in-progress mosaic snapshots emitted during generate.
const PROGRESS_FRAME_MS = 120
// Minimum gap between lightweight progress messages. These do not carry a
// rendered bitmap, so they can be much more frequent than visual snapshots.
const PROGRESS_EVENT_MS = 33
// Thumbnail fetches in flight at once. Supabase Storage serves over HTTP/2, so a
// high fan-out multiplexes over one connection and hides per-request latency —
// this is the main lever that keeps generation fast despite the network hop.
const FETCH_CONCURRENCY = 48
// Cap on the cross-generate decoded-tile cache. Bitmaps are ~BASE_TILE_MAX, so
// ~50 KB each; this bounds worst-case memory while comfortably covering a single
// generate's working set (so in-use tiles are never evicted mid-render).
const TILE_CACHE_CAP = 3000
// Duplicate spreading: a tile already placed within this many mean cell pitches
// of the cell being matched is skipped, so repeats of the same photo scatter
// across the mosaic instead of clustering in one patch. Matching still runs in
// cell order (contour/border cells first), so their first-pick quality is
// unchanged; only would-be adjacent duplicates fall back to the next-best
// color match. Relaxed when nothing qualifies so cells are never left empty.
const DUP_MIN_DIST_PITCHES = 6

// Tile matching runs on a downsampled signature: with a 7000+ tile library, the
// full SIGNATURE_GRID² signature makes matching by far the dominant cost. Halving
// the grid (e.g. 16×16 → 8×8) cuts the per-comparison work ~4× while still
// matching on the tile's color layout, so the mosaic looks the same. Computed by
// averaging 2×2 blocks of the stored signature.
const FULL_GRID = SIGNATURE_GRID
const COARSE_GRID = Math.max(1, FULL_GRID >> 1)
const COARSE_LEN = COARSE_GRID * COARSE_GRID * 3
const COARSE_CHANNELS = COARSE_GRID * COARSE_GRID

function downsampleSig(s: ArrayLike<number>): Float32Array {
  const out = new Float32Array(COARSE_LEN)
  for (let by = 0; by < COARSE_GRID; by++) {
    for (let bx = 0; bx < COARSE_GRID; bx++) {
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            sum += s[((by * 2 + dy) * FULL_GRID + (bx * 2 + dx)) * 3 + ch]
          }
        }
        out[(by * COARSE_GRID + bx) * 3 + ch] = sum * 0.25
      }
    }
  }
  return out
}

type Entry = {
  coarse: Float32Array
  meanR: number
  meanG: number
  meanB: number
  w: number
  h: number
  url: string
}

type PreparedLibrary = {
  ids: string[]
  coarse: Float32Array[]
  means: Float32Array
}

function meanRgb(coarse: Float32Array): [number, number, number] {
  let r = 0
  let g = 0
  let b = 0
  for (let i = 0; i < COARSE_LEN; i += 3) {
    r += coarse[i]
    g += coarse[i + 1]
    b += coarse[i + 2]
  }
  return [r / COARSE_CHANNELS, g / COARSE_CHANNELS, b / COARSE_CHANNELS]
}

function prepareLibrary(items: HydrateItem[]): PreparedLibrary {
  const ids = new Array<string>(items.length)
  const coarse = new Array<Float32Array>(items.length)
  const means = new Float32Array(items.length * 3)
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    ids[i] = item.id
    const cs = downsampleSig(item.sig)
    coarse[i] = cs
    const [r, g, b] = meanRgb(cs)
    means[i * 3] = r
    means[i * 3 + 1] = g
    means[i * 3 + 2] = b
  }
  return { ids, coarse, means }
}

function preparedMatchesIds(library: PreparedLibrary, ids: string[]): boolean {
  if (library.ids.length !== ids.length) return false
  for (let i = 0; i < ids.length; i++) {
    if (library.ids[i] !== ids[i]) return false
  }
  return true
}

function getPreparedLibrary(ids: string[]): PreparedLibrary {
  if (preparedLibrary && preparedMatchesIds(preparedLibrary, ids)) {
    return preparedLibrary
  }

  const coarse = new Array<Float32Array>(ids.length)
  const means = new Float32Array(ids.length * 3)
  const empty = new Float32Array(COARSE_LEN)
  for (let i = 0; i < ids.length; i++) {
    const entry = store.get(ids[i])
    const cs = entry?.coarse ?? empty
    coarse[i] = cs
    means[i * 3] = entry?.meanR ?? 0
    means[i * 3 + 1] = entry?.meanG ?? 0
    means[i * 3 + 2] = entry?.meanB ?? 0
  }
  return { ids: [...ids], coarse, means }
}

// Everything we keep per photo after hydration: the derived comparison signature
// plus the thumbnail URL/dimensions. The original full signature is intentionally
// discarded so each generate can reuse this prepared table instead of rebuilding
// it from the cached signature blob.
const store = new Map<string, Entry>()
let preparedLibrary: PreparedLibrary | null = null

// Decoded thumbnails, keyed by photo id, reused across generates. Insertion
// order doubles as an LRU: hits are re-inserted to the end, and we prune from
// the front (oldest) between generates so nothing in use is ever closed.
const tileCache = new Map<string, ImageBitmap>()

// Id of the generate currently rendering. A newer generate bumps this so the
// older loop notices and abandons its work (rather than wasting cycles).
let activeGenerate = 0

function post(message: WorkerResponse, transfer?: Transferable[]) {
  scope.postMessage(message, transfer ?? [])
}

// Decoded-tile cache helpers. `get` bumps recency so the current generate's
// tiles sort newest and survive pruning.
function cacheGet(id: string): ImageBitmap | undefined {
  const bmp = tileCache.get(id)
  if (bmp) {
    tileCache.delete(id)
    tileCache.set(id, bmp)
  }
  return bmp
}

// Prune the cache to its cap, closing evicted bitmaps. Called only between
// generates so a bitmap referenced by the in-flight render is never closed.
function pruneTileCache() {
  while (tileCache.size > TILE_CACHE_CAP) {
    const oldest = tileCache.keys().next().value
    if (oldest === undefined) break
    tileCache.get(oldest)?.close()
    tileCache.delete(oldest)
  }
}

// Fetch + decode one tile's thumbnail at cell resolution, returning a cached
// bitmap when available. Thumbnails come through the app's mosaic proxy route,
// which now marks them immutable, so `cache: "force-cache"` serves repeat fetches
// straight from the browser HTTP cache with no network round-trip — no separate
// Cache Storage layer (whose per-tile reads/writes serialized on a shared lock
// and grew slower as the backlog built up) is needed.
async function decodeTile(id: string): Promise<ImageBitmap | undefined> {
  const hit = cacheGet(id)
  if (hit) return hit
  const entry = store.get(id)
  if (!entry) return undefined
  const scale = Math.min(1, BASE_TILE_MAX / Math.max(entry.w, entry.h))
  const rw = Math.max(1, Math.round(entry.w * scale))
  const rh = Math.max(1, Math.round(entry.h * scale))
  try {
    const res = await fetch(entry.url, { cache: "force-cache" })
    if (!res.ok) return undefined
    const blob = await res.blob()
    const bmp = await createImageBitmap(blob, {
      resizeWidth: rw,
      resizeHeight: rh,
      resizeQuality: "medium",
    })
    tileCache.set(id, bmp)
    return bmp
  } catch {
    return undefined
  }
}

async function handleGenerate(
  reqId: number,
  cellSigs: Float32Array[],
  grid: Grid,
  ids: string[],
  width: number,
  height: number,
  angles: Float32Array,
  polys: Float32Array,
  offsets: Int32Array,
  maxTileReuse?: number
): Promise<void> {
  activeGenerate = reqId

  // Per tile: its coarse (downsampled) signature for matching, plus its mean RGB
  // which drives an exact lower-bound prune (coarse SSD >= COARSE_CHANNELS *
  // meanColorDistSq), so tiles too far in average color skip the inner loop.
  const library = getPreparedLibrary(ids)
  const nTiles = ids.length
  if (nTiles === 0) return
  const tileCoarse = library.coarse
  const tileMeans = library.means
  const reuseCap =
    maxTileReuse !== undefined && Number.isFinite(maxTileReuse)
      ? Math.max(1, Math.floor(maxTileReuse))
      : 0
  const useCounts = reuseCap ? new Uint32Array(nTiles) : null
  // Reused per cell: squared mean-color distance to each tile.
  const mds = new Float32Array(nTiles)

  // Cell centroids (vertex mean of each polygon) and the mean cell pitch, for
  // the duplicate-spreading constraint below.
  const cellCount = cellSigs.length
  const cellCx = new Float32Array(cellCount)
  const cellCy = new Float32Array(cellCount)
  for (let cell = 0; cell < cellCount; cell++) {
    const v0 = offsets[cell]
    const v1 = offsets[cell + 1]
    let sx = 0
    let sy = 0
    for (let v = v0; v < v1; v++) {
      sx += polys[v * 2]
      sy += polys[v * 2 + 1]
    }
    const m = Math.max(1, v1 - v0)
    cellCx[cell] = sx / m
    cellCy[cell] = sy / m
  }
  const pitch = Math.sqrt((width * height) / Math.max(1, cellCount))
  const dupMinDist2 = DUP_MIN_DIST_PITCHES * pitch * (DUP_MIN_DIST_PITCHES * pitch)
  // Per tile: x,y pairs of the cells it's already been placed in, so each new
  // use can be kept away from every previous one.
  const placements: (number[] | undefined)[] = new Array(nTiles)

  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext("2d")
  if (!ctx) return
  // Transparent background — the main thread paints the reference's average color
  // (the grout) behind the tiles so the gaps and tile shadows sit on-palette.

  // One tile per signature — the count is driven by `cellSigs`, not the grid, so
  // the same path serves both the grid layout (voronoi, where it equals
  // cols×rows) and the free-form contour-flow layout (an arbitrary tile count).
  const assignment = new Int32Array(cellCount)

  // ── Phase 1: match every cell to its nearest tile (CPU only, no network) ────
  // Nearest tile by summed squared error over the coarse signature, skipping
  // tiles that already hit this generated mosaic's reuse cap or that are
  // already placed within the duplicate-spacing radius. Two accelerations keep
  // it faster than a brute-force scan:
  //   1. A mean-RGB prefilter picks the closest tile by average color and seeds
  //      `bestErr` with its real error — a tight initial bound so the work below
  //      stays small.
  //   2. An exact lower-bound prune (COARSE_CHANNELS * meanDistSq >= bestErr)
  //      skips far-colored tiles outright, and the inner early-exit abandons the
  //      rest as soon as their partial sum reaches the current best.
  for (let cell = 0; cell < cellCount; cell++) {
    const cs = downsampleSig(cellSigs[cell])

    // Cell mean RGB + squared mean distance to every tile; track the nearest.
    let cr = 0
    let cg = 0
    let cb = 0
    for (let i = 0; i < COARSE_LEN; i += 3) {
      cr += cs[i]
      cg += cs[i + 1]
      cb += cs[i + 2]
    }
    cr /= COARSE_CHANNELS
    cg /= COARSE_CHANNELS
    cb /= COARSE_CHANNELS
    for (let t = 0; t < nTiles; t++) {
      const dr = cr - tileMeans[t * 3]
      const dg = cg - tileMeans[t * 3 + 1]
      const db = cb - tileMeans[t * 3 + 2]
      mds[t] = dr * dr + dg * dg + db * db
    }

    // True when tile `t` is already placed too close to this cell for a repeat.
    const px = cellCx[cell]
    const py = cellCy[cell]
    const tooClose = (t: number): boolean => {
      const p = placements[t]
      if (!p) return false
      for (let i = 0; i < p.length; i += 2) {
        const dx = p[i] - px
        const dy = p[i + 1] - py
        if (dx * dx + dy * dy < dupMinDist2) return true
      }
      return false
    }
    // Constraint levels, relaxed in order only when no tile qualifies (so cells
    // are never left empty): 0 = reuse cap + duplicate spacing, 1 = reuse cap
    // only, 2 = any tile.
    const blockedAt = (t: number, lvl: number): boolean =>
      (lvl < 2 && useCounts !== null && useCounts[t] >= reuseCap) ||
      (lvl < 1 && tooClose(t))

    // Nearest unblocked tile by mean color seeds the error bound, at the
    // tightest constraint level that still has a candidate.
    let seed = -1
    let seedDist = Infinity
    let level = 0
    for (; level <= 2; level++) {
      for (let t = 0; t < nTiles; t++) {
        if (blockedAt(t, level)) continue
        if (mds[t] < seedDist) {
          seedDist = mds[t]
          seed = t
        }
      }
      if (seed >= 0) break
    }

    // Seed bestErr with the prefilter pick's full coarse error.
    let best = seed
    let bestErr = 0
    {
      const ts = tileCoarse[seed]
      for (let i = 0; i < COARSE_LEN; i++) {
        const d = cs[i] - ts[i]
        bestErr += d * d
      }
    }

    // Scan, skipping tiles the mean-color lower bound rules out.
    for (let t = 0; t < nTiles; t++) {
      if (t === seed) continue
      if (blockedAt(t, level)) continue
      if (COARSE_CHANNELS * mds[t] >= bestErr) continue
      const ts = tileCoarse[t]
      let sum = 0
      let i = 0
      for (; i < COARSE_LEN; i++) {
        const d = cs[i] - ts[i]
        sum += d * d
        if (sum >= bestErr) break
      }
      if (i === COARSE_LEN && sum < bestErr) {
        bestErr = sum
        best = t
      }
    }
    assignment[cell] = best
    if (useCounts) useCounts[best]++
    const placed = placements[best] ?? (placements[best] = [])
    placed.push(px, py)
  }
  if (activeGenerate !== reqId) return

  // ── Phase 2: fetch the unique placed tiles in parallel, painting as they land ─
  // Bitmaps ready this generate (tile index → bitmap). The bitmaps are owned by
  // the cross-generate cache, so we never close them here.
  const ready = new Map<number, ImageBitmap>()
  const uniqueTiles = Array.from(new Set(assignment))

  // Full clear + repaint of every ready cell, in cell order. Reserved for the
  // final frame so its shadow layering (later tiles' shadows spill over earlier
  // tiles) is deterministic. This is O(cells), so it must NOT run per progress
  // frame — doing so made the preview cost grow with each tile placed.
  const repaintAll = () => {
    ctx.clearRect(0, 0, width, height)
    for (let cell = 0; cell < cellCount; cell++) {
      const bmp = ready.get(assignment[cell])
      if (bmp) {
        drawPolygonCell(ctx, polys, offsets, cell, bmp, angles[cell], {
          width,
          height,
        })
      }
    }
  }

  // Cells already drawn onto the accumulating canvas. The progress preview draws
  // ONLY newly-ready cells (no clear), so total draw work across the whole
  // generate is O(cells) instead of O(cells × frames). That keeps the fetch loop
  // from decelerating as more tiles land — the cause of the ~50% slowdown.
  const painted = new Uint8Array(cellCount)
  const paintNewlyReady = () => {
    for (let cell = 0; cell < cellCount; cell++) {
      if (painted[cell]) continue
      const bmp = ready.get(assignment[cell])
      if (!bmp) continue
      drawPolygonCell(ctx, polys, offsets, cell, bmp, angles[cell], {
        width,
        height,
      })
      painted[cell] = 1
    }
  }

  let fetched = 0
  let lastProgress = 0
  const emitProgress = (force = false) => {
    const now = performance.now()
    if (!force && now - lastProgress < PROGRESS_EVENT_MS) return
    lastProgress = now
    post({ type: "progress", reqId, done: fetched, total: uniqueTiles.length })
  }
  emitProgress(true)

  let lastFrame = performance.now()
  let framing = false
  const emitFrame = async () => {
    if (framing) return
    framing = true
    paintNewlyReady()
    const snapshot = await createImageBitmap(canvas)
    if (activeGenerate !== reqId) {
      snapshot.close()
      framing = false
      return
    }
    post(
      {
        type: "progressFrame",
        reqId,
        base: snapshot,
        done: fetched,
        total: uniqueTiles.length,
      },
      [snapshot]
    )
    framing = false
  }

  let cursor = 0
  const fetchWorker = async () => {
    for (;;) {
      if (activeGenerate !== reqId) return
      const k = cursor++
      if (k >= uniqueTiles.length) return
      const tileIdx = uniqueTiles[k]
      const bmp = await decodeTile(ids[tileIdx])
      if (activeGenerate !== reqId) return
      if (bmp) ready.set(tileIdx, bmp)
      fetched++
      emitProgress(fetched === uniqueTiles.length)
      const now = performance.now()
      if (
        now - lastFrame >= PROGRESS_FRAME_MS &&
        fetched < uniqueTiles.length
      ) {
        lastFrame = now
        await emitFrame()
      }
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(FETCH_CONCURRENCY, uniqueTiles.length) },
      fetchWorker
    )
  )
  if (activeGenerate !== reqId) return

  // ── Phase 3: final paint + hand the finished frame to the main thread ───────
  // One authoritative full repaint so the finished image's shadow layering is
  // identical to a from-scratch render, regardless of the order tiles arrived in.
  repaintAll()
  const base = canvas.transferToImageBitmap()
  // Safe to prune now: no in-flight render references these bitmaps anymore.
  pruneTileCache()
  if (activeGenerate !== reqId) {
    base.close()
    return
  }
  post({ type: "generated", reqId, assignment, base }, [
    base,
    assignment.buffer,
  ])
}

scope.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  switch (msg.type) {
    case "generate":
      void handleGenerate(
        msg.reqId,
        msg.cellSigs,
        msg.grid,
        msg.ids,
        msg.width,
        msg.height,
        msg.angles,
        msg.polys,
        msg.offsets,
        msg.maxTileReuse
      )
      break
    case "hydrate":
      // Restore library tiles into the store so they're usable immediately. The
      // expensive comparison data is derived once here; image bytes are fetched
      // lazily when a tile is placed.
      preparedLibrary = prepareLibrary(msg.items as HydrateItem[])
      store.clear()
      for (let i = 0; i < preparedLibrary.ids.length; i++) {
        const it = msg.items[i]
        store.set(it.id, {
          coarse: preparedLibrary.coarse[i],
          meanR: preparedLibrary.means[i * 3],
          meanG: preparedLibrary.means[i * 3 + 1],
          meanB: preparedLibrary.means[i * 3 + 2],
          w: it.w,
          h: it.h,
          url: it.url,
        })
      }
      break
  }
}
