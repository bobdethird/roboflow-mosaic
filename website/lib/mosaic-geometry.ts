// Per-tile geometry — the artifact that powers zoom-to-reveal. The coarse hover
// hit-map (mosaic-hitmap.ts) is enough to answer "which photo is under this
// spot?" but not "where is every tile, and how big/rotated?" — which is what the
// zoom overlay needs to repaint the real source photos in place as you zoom in.
//
// Each cell is reduced to a center (x,y), an angle, and an index into a compacted
// tile list (url + thumbnail + title). That's a rotated-square-per-tile model: at
// zoom we paint each photo into a `tileSize`-sided square at its center/angle,
// over the same baked composite, so edges line up and max zoom shows one real
// photo. The cell→photo arrays are shipped as base64-encoded typed buffers so the
// JSON stays compact (~tens of KB for thousands of cells), and the payload is
// only ever fetched lazily on the first zoom — never on first paint.

import type { GalleryTile } from "./gallery"

// Decoded, ready-to-render geometry the zoom viewer consumes.
export type MosaicGeometry = {
  frameW: number
  frameH: number
  // Mosaic cell size in frame px; the on-screen tile side is tileSize·displayScale·zoom.
  tileSize: number
  count: number
  // Per-cell, parallel arrays (length `count`).
  cx: Float32Array
  cy: Float32Array
  ang: Float32Array
  // Index into `tiles`, or -1 for an unassigned cell.
  t: Int32Array
  // Compacted source photos referenced by `t`.
  tiles: GalleryTile[]
}

// Wire/JSON form: typed arrays as base64, everything else inline.
export type EncodedMosaicGeometry = {
  v: 1
  frameW: number
  frameH: number
  tileSize: number
  count: number
  cx: string
  cy: string
  ang: string
  t: string
  tiles: GalleryTile[]
}

// ─── base64 ⇄ typed arrays (isomorphic: btoa/atob exist in Node ≥16 + browsers) ─

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function f32ToBase64(arr: Float32Array): string {
  return bytesToBase64(
    new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
  )
}

function i32ToBase64(arr: Int32Array): string {
  return bytesToBase64(
    new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
  )
}

// base64ToBytes returns a fresh, offset-0 buffer, so reinterpreting it as
// Float32/Int32 is safe (length is a multiple of 4 by construction here).
function base64ToF32(b64: string, count: number): Float32Array | null {
  const bytes = base64ToBytes(b64)
  if (bytes.byteLength !== count * 4) return null
  return new Float32Array(bytes.buffer, 0, count)
}

function base64ToI32(b64: string, count: number): Int32Array | null {
  const bytes = base64ToBytes(b64)
  if (bytes.byteLength !== count * 4) return null
  return new Int32Array(bytes.buffer, 0, count)
}

// ─── build ───────────────────────────────────────────────────────────────────

// Reduce a generated mosaic's per-cell data to shippable geometry. `assignment`
// indexes into `tileIds`; `resolveTile` turns an id into its GalleryTile — the
// same callback the publish/bake flows already build. Mirrors the tile-compaction
// in buildMosaicHitMap so only referenced photos travel.
export function buildMosaicGeometry(opts: {
  frameW: number
  frameH: number
  tileSize: number
  centers: Float32Array
  angles: Float32Array
  assignment: Int32Array
  tileIds: string[]
  resolveTile: (id: string) => GalleryTile
}): MosaicGeometry {
  const { frameW, frameH, tileSize, centers, angles, assignment, tileIds } =
    opts
  const count = Math.min(centers.length / 2, angles.length, assignment.length)
  const cx = new Float32Array(count)
  const cy = new Float32Array(count)
  const ang = new Float32Array(count)
  const t = new Int32Array(count)

  const compact = new Map<number, number>()
  const tiles: GalleryTile[] = []
  for (let i = 0; i < count; i++) {
    cx[i] = centers[i * 2]
    cy[i] = centers[i * 2 + 1]
    ang[i] = angles[i]
    const a = assignment[i]
    if (a < 0 || a >= tileIds.length) {
      t[i] = -1
      continue
    }
    let ci = compact.get(a)
    if (ci === undefined) {
      tiles.push(opts.resolveTile(tileIds[a]))
      ci = tiles.length - 1
      compact.set(a, ci)
    }
    t[i] = ci
  }

  return { frameW, frameH, tileSize, count, cx, cy, ang, t, tiles }
}

export function encodeGeometry(geo: MosaicGeometry): EncodedMosaicGeometry {
  return {
    v: 1,
    frameW: geo.frameW,
    frameH: geo.frameH,
    tileSize: geo.tileSize,
    count: geo.count,
    cx: f32ToBase64(geo.cx),
    cy: f32ToBase64(geo.cy),
    ang: f32ToBase64(geo.ang),
    t: i32ToBase64(geo.t),
    tiles: geo.tiles,
  }
}

// Largest cell count we'll accept end-to-end (matcher caps well below this; the
// bound just keeps a malformed payload from allocating absurd buffers).
export const MAX_GEOMETRY_CELLS = 1_000_000

function cleanTiles(raw: unknown): GalleryTile[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const tiles: GalleryTile[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null
    const t = entry as Record<string, unknown>
    if (typeof t.url !== "string" || typeof t.title !== "string") return null
    tiles.push({
      url: t.url,
      title: t.title,
      previewUrl: typeof t.previewUrl === "string" ? t.previewUrl : undefined,
    })
  }
  return tiles
}

// Validate an untrusted encoded payload (the share route's trust boundary, and
// defensively on the client after fetch). Returns the canonical encoded object —
// re-keyed to just the known fields — or null. Decodes the buffers to confirm
// lengths and that every tile index points into `tiles`.
export function validateEncodedGeometry(
  data: unknown
): EncodedMosaicGeometry | null {
  if (!data || typeof data !== "object") return null
  const m = data as Record<string, unknown>
  const { frameW, frameH, tileSize, count } = m
  if (
    !Number.isFinite(frameW) ||
    !Number.isFinite(frameH) ||
    !Number.isFinite(tileSize) ||
    !Number.isInteger(count) ||
    (frameW as number) < 1 ||
    (frameH as number) < 1 ||
    (tileSize as number) < 1 ||
    (count as number) < 0 ||
    (count as number) > MAX_GEOMETRY_CELLS ||
    typeof m.cx !== "string" ||
    typeof m.cy !== "string" ||
    typeof m.ang !== "string" ||
    typeof m.t !== "string"
  ) {
    return null
  }

  const tiles = cleanTiles(m.tiles)
  if (!tiles) return null

  const n = count as number
  let cx: Float32Array | null
  let cy: Float32Array | null
  let ang: Float32Array | null
  let t: Int32Array | null
  try {
    cx = base64ToF32(m.cx, n)
    cy = base64ToF32(m.cy, n)
    ang = base64ToF32(m.ang, n)
    t = base64ToI32(m.t, n)
  } catch {
    return null
  }
  if (!cx || !cy || !ang || !t) return null
  for (let i = 0; i < n; i++) {
    if (t[i] < -1 || t[i] >= tiles.length) return null
  }

  return {
    v: 1,
    frameW: frameW as number,
    frameH: frameH as number,
    tileSize: tileSize as number,
    count: n,
    cx: m.cx,
    cy: m.cy,
    ang: m.ang,
    t: m.t,
    tiles,
  }
}

// Decode a fetched payload for rendering. Reuses the validator (so the client is
// equally defensive about a corrupt/old artifact), then materializes the arrays.
export function decodeGeometry(data: unknown): MosaicGeometry | null {
  const enc = validateEncodedGeometry(data)
  if (!enc) return null
  const cx = base64ToF32(enc.cx, enc.count)
  const cy = base64ToF32(enc.cy, enc.count)
  const ang = base64ToF32(enc.ang, enc.count)
  const t = base64ToI32(enc.t, enc.count)
  if (!cx || !cy || !ang || !t) return null
  return {
    frameW: enc.frameW,
    frameH: enc.frameH,
    tileSize: enc.tileSize,
    count: enc.count,
    cx,
    cy,
    ang,
    t,
    tiles: enc.tiles,
  }
}

// ─── client-side tile image cache ─────────────────────────────────────────────
// The overlay needs decoded images for only the handful of tiles on screen, and
// must not stampede the network when panning. This caches loaded images by url
// (LRU) and limits concurrent loads; `request` dedupes and notifies via onLoad so
// the viewer can repaint when a tile arrives. Framework-free so all three
// surfaces share one instance behavior.
export class TileImageCache {
  private ready = new Map<string, HTMLImageElement>()
  private inflight = new Map<string, Promise<void>>()
  private order: string[] = []
  private active = 0
  private waiting: string[] = []
  // Currently on-screen urls. Eviction never drops these, so a tile that's
  // visible can't be evicted and reloaded mid-zoom — which is what caused the
  // overlay to flicker when paused at a partial zoom (hundreds of tiles visible,
  // more than the cap, thrashing the cache).
  private pinned: Set<string> = new Set()
  private readonly max: number
  private readonly concurrency: number
  // Called (deduped by the caller) whenever a new image finishes loading.
  onLoad: (() => void) | null = null

  constructor(opts?: { max?: number; concurrency?: number }) {
    this.max = opts?.max ?? 1024
    this.concurrency = opts?.concurrency ?? 12
  }

  // Declare the set of urls currently on screen so eviction spares them.
  pin(urls: Set<string>): void {
    this.pinned = urls
  }

  // A decoded image if it's already loaded (marks it most-recently-used), else null.
  get(url: string): HTMLImageElement | null {
    const img = this.ready.get(url)
    if (img) this.touch(url)
    return img ?? null
  }

  // Ensure `url` is loading or loaded. Safe to call every frame.
  request(url: string): void {
    if (this.ready.has(url) || this.inflight.has(url)) return
    if (this.active >= this.concurrency) {
      if (!this.waiting.includes(url)) this.waiting.push(url)
      return
    }
    this.start(url)
  }

  private start(url: string): void {
    this.active++
    const promise = new Promise<void>((resolve) => {
      const img = new Image()
      img.decoding = "async"
      const done = (ok: boolean) => {
        this.inflight.delete(url)
        this.active--
        if (ok) {
          this.ready.set(url, img)
          this.touch(url)
          this.evict()
          this.onLoad?.()
        }
        this.pump()
        resolve()
      }
      img.onload = () => done(true)
      img.onerror = () => done(false)
      img.src = url
    })
    this.inflight.set(url, promise)
  }

  private pump(): void {
    while (this.active < this.concurrency && this.waiting.length > 0) {
      const url = this.waiting.shift()!
      if (this.ready.has(url) || this.inflight.has(url)) continue
      this.start(url)
    }
  }

  private touch(url: string): void {
    const i = this.order.indexOf(url)
    if (i >= 0) this.order.splice(i, 1)
    this.order.push(url)
  }

  private evict(): void {
    let removable = this.order.length - this.max
    if (removable <= 0) return
    // Drop the oldest UNpinned entries first; never evict an on-screen tile (so
    // it can't vanish and reload). If everything left is pinned the cache simply
    // grows past `max` for that frame — bounded by the visible set.
    const next: string[] = []
    for (const url of this.order) {
      if (removable > 0 && !this.pinned.has(url)) {
        this.ready.delete(url)
        removable--
      } else {
        next.push(url)
      }
    }
    this.order = next
  }
}
