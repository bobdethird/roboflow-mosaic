// Match stage: assign one photo-frame tile to every contour-flow Voronoi cell
// of the reference, mirroring the /knicks-mosaic web page:
//
//   - Tile pool   = the photo-frames library (data/photo-frames/<videoId>/*.jpg,
//     the same stills the page's Supabase library is seeded from), flatness-
//     filtered and content-deduped exactly like photo-seed.mjs.
//   - Geometry    = lib/contour-mosaic.ts (contour-flow seeds → Voronoi cells),
//     run over the centered reference rect at the page-equivalent tile size.
//   - Matching    = coarse-signature SSD with a per-tile reuse cap, mirroring
//     lib/mosaic-worker.ts (mean-RGB prefilter + exact lower-bound prune).
//
// The plan it writes carries the packed cell polygons so 04-clips and
// 05-render can size, cull and draw the organic tiles.

import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import sharp from "sharp"

import { contourMosaic } from "../../lib/contour-mosaic.ts"
import { CONFIG } from "./config.mjs"
import { ensureDir, exists, readJson, writeJson } from "./lib/common.mjs"
import { ensureReferenceImage } from "./lib/media.mjs"
import {
  cellBBoxes,
  COARSE_CHANNELS,
  COARSE_LEN,
  downsampleSig,
  edgeVectorField,
  encodeGeometry,
  fieldDimsFor,
  meanRgb,
  referenceWindowSignatures,
} from "./lib/mosaic-node.mjs"
import { probeDuration, samplingParams } from "./lib/photo-sampling.mjs"
import {
  decodeSignature,
  encodeSignature,
  lumStd,
  signatureFromImage,
} from "./lib/signature.mjs"
import { mosaicLayoutForReference } from "./lib/viewport.mjs"

const SIG_CONCURRENCY = Math.max(2, os.cpus().length)
const SIG_CACHE_PATH = path.join(
  CONFIG.paths.indexesDir,
  "photo-signatures.json"
)

async function runPool(items, concurrency, fn) {
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      await fn(items[i], i)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  )
}

// Frame files of the photo library, ordered like the page's seeder (sorted
// video dirs, sorted frame names) so dedupe tie-breaking matches.
async function listFrameFiles() {
  const root = CONFIG.paths.photoFramesDir
  if (!(await exists(root))) return []
  const dirs = (await fs.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
  const files = []
  for (const dir of dirs) {
    const dirPath = path.join(root, dir)
    const names = (await fs.readdir(dirPath))
      .filter((name) => /^frame_\d+\.jpg$/i.test(name))
      .sort((a, b) => a.localeCompare(b))
    for (const name of names) {
      files.push({
        videoId: dir,
        frameIndex: Number(name.match(/^frame_(\d+)\.jpg$/i)[1]),
        path: path.join(dirPath, name),
      })
    }
  }
  return files
}

// Per-video sampling params (fps/startAt) so frame N maps to its source-video
// timestamp. Prefer the manifest photo-frames.mjs writes; recompute the same
// deterministic values for extractions that predate it. Videos no longer on
// disk get null (their tiles render as stills; 04-clips copies the frame).
async function loadSamplingByVideo(videoIds, tierById) {
  const manifest = await readJson(
    path.join(CONFIG.paths.photoFramesDir, "manifest.json")
  )
  const result = new Map()
  for (const videoId of videoIds) {
    const entry = manifest?.videos?.[videoId]
    if (entry && Number.isFinite(entry.fps)) {
      result.set(videoId, { fps: entry.fps, startAt: entry.startAt ?? 0 })
      continue
    }
    const videoPath = path.join(CONFIG.paths.videosDir, `${videoId}.mp4`)
    if (!(await exists(videoPath))) {
      result.set(videoId, null)
      continue
    }
    const duration = await probeDuration(videoPath)
    const { fps, startAt } = samplingParams(duration, tierById.get(videoId))
    result.set(videoId, { fps, startAt })
  }
  return result
}

// Index every library frame: 16×16 signature (cached across runs by path +
// mtime), flatness filter and content-hash dedupe — the same pipeline the
// Supabase library goes through in photo-seed.mjs.
async function buildPool(tierById, samplingByVideo) {
  const files = await listFrameFiles()
  if (files.length === 0) {
    throw new Error(
      `No frames in ${CONFIG.paths.photoFramesDir}. Run pnpm knicks:photo-frames first.`
    )
  }

  const cache = (await readJson(SIG_CACHE_PATH, { entries: {} })).entries ?? {}
  const nextCache = {}
  let computed = 0
  let done = 0

  const indexed = new Array(files.length).fill(null)
  await runPool(files, SIG_CONCURRENCY, async (file, i) => {
    try {
      const stat = await fs.stat(file.path)
      const rel = path.relative(CONFIG.paths.photoFramesDir, file.path)
      const cached = cache[rel]
      let sig
      let hash
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        sig = decodeSignature(cached.sig)
        hash = cached.hash
      } else {
        const buf = await fs.readFile(file.path)
        sig = await signatureFromImage(buf)
        hash = createHash("sha256")
          .update(buf)
          .digest()
          .subarray(0, 12)
          .toString("hex")
        computed++
      }
      nextCache[rel] = {
        mtimeMs: stat.mtimeMs,
        sig: encodeSignature(sig),
        hash,
      }
      if (lumStd(sig) < CONFIG.photo.flatnessMinStd) return
      indexed[i] = { ...file, sig, hash }
    } finally {
      done++
      if (done % 500 === 0 || done === files.length) {
        process.stdout.write(`\r  indexed ${done}/${files.length}`)
      }
    }
  })
  process.stdout.write("\n")
  await ensureDir(path.dirname(SIG_CACHE_PATH))
  await writeJson(SIG_CACHE_PATH, { entries: nextCache })

  // Content-dedupe, first-seen order (matches the page library's id dedupe).
  const pool = []
  const seen = new Set()
  for (const tile of indexed) {
    if (!tile) continue
    if (seen.has(tile.hash)) continue
    seen.add(tile.hash)
    const sampling = samplingByVideo.get(tile.videoId)
    const t = sampling
      ? sampling.startAt + (tile.frameIndex - 1) / sampling.fps
      : null
    pool.push({
      key: `${tile.videoId}_f${String(tile.frameIndex).padStart(4, "0")}`,
      videoId: tile.videoId,
      tier: tierById.get(tile.videoId) ?? "filler",
      framePath: tile.path,
      frameIndex: tile.frameIndex,
      t,
      sig: tile.sig,
      coarse: downsampleSig(tile.sig),
    })
  }
  console.log(
    `  pool: ${pool.length} tiles (${computed} signatures computed, rest cached)`
  )
  return pool
}

// Nearest tile by summed squared error over the coarse signature, mirroring
// the page worker: a mean-RGB prefilter seeds the error bound, an exact
// lower-bound prune skips far-colored tiles, and tiles at the reuse cap (or
// past the unique-clip budget) are skipped, relaxing when nothing qualifies.
function matchCells({ cellSigs, order, pool, eligibleByCell }) {
  const reuseCap = Math.max(1, Math.floor(CONFIG.mosaic.tileReuseCap || 0)) || 0
  const { maxUniqueClips } = CONFIG.mosaic
  const nTiles = pool.length
  const means = new Float32Array(nTiles * 3)
  for (let t = 0; t < nTiles; t++) {
    const [r, g, b] = meanRgb(pool[t].coarse)
    means[t * 3] = r
    means[t * 3 + 1] = g
    means[t * 3 + 2] = b
  }
  const useCounts = new Uint32Array(nTiles)
  const usedUnique = new Set()
  const mds = new Float32Array(nTiles)
  const assignment = new Int32Array(cellSigs.length).fill(-1)
  const errors = new Float32Array(cellSigs.length)

  for (const cell of order) {
    const cs = downsampleSig(cellSigs[cell])
    const eligible = eligibleByCell?.(cell) ?? null
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

    const blocked = (t) =>
      (eligible && !eligible.has(t)) ||
      (reuseCap && useCounts[t] >= reuseCap) ||
      (maxUniqueClips &&
        usedUnique.size >= maxUniqueClips &&
        !usedUnique.has(t))

    // Mean-color distances; track the nearest unblocked tile as the seed.
    let seed = -1
    let seedDist = Infinity
    for (let t = 0; t < nTiles; t++) {
      const dr = cr - means[t * 3]
      const dg = cg - means[t * 3 + 1]
      const db = cb - means[t * 3 + 2]
      const d = dr * dr + dg * dg + db * db
      mds[t] = d
      if (blocked(t)) continue
      if (d < seedDist) {
        seedDist = d
        seed = t
      }
    }
    // Pool exhausted under the constraints — relax to any tile (rare; mirrors
    // the worker's relaxation so a cell is never left empty).
    let relaxed = false
    if (seed < 0) {
      relaxed = true
      for (let t = 0; t < nTiles; t++) {
        if (mds[t] < seedDist) {
          seedDist = mds[t]
          seed = t
        }
      }
    }

    let best = seed
    let bestErr = 0
    {
      const ts = pool[seed].coarse
      for (let i = 0; i < COARSE_LEN; i++) {
        const d = cs[i] - ts[i]
        bestErr += d * d
      }
    }
    for (let t = 0; t < nTiles; t++) {
      if (t === seed) continue
      if (!relaxed && blocked(t)) continue
      if (COARSE_CHANNELS * mds[t] >= bestErr) continue
      const ts = pool[t].coarse
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
    errors[cell] = bestErr
    useCounts[best]++
    usedUnique.add(best)
  }
  return { assignment, errors }
}

async function main() {
  await ensureDir(CONFIG.dataDir)
  const referencePath = await ensureReferenceImage()
  const sources = await readJson(CONFIG.paths.sourcesPath, { videos: [] })
  const tierById = new Map(
    (sources.videos ?? []).map((video) => [video.id, video.tier])
  )

  // ---- Tile pool from the photo-frames library ------------------------------
  const frameDirs = (
    await fs.readdir(CONFIG.paths.photoFramesDir, { withFileTypes: true })
  )
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
  const samplingByVideo = await loadSamplingByVideo(frameDirs, tierById)
  const pool = await buildPool(tierById, samplingByVideo)

  // ---- Contour-flow Voronoi geometry over the reference rect ----------------
  const refMeta = await sharp(referencePath).rotate().metadata()
  const layout = mosaicLayoutForReference(refMeta.width, refMeta.height)
  const rectLongEdge = Math.max(layout.w, layout.h)
  const tileSize =
    CONFIG.mosaic.tileSizeOverride ||
    (CONFIG.mosaic.tileDensity * rectLongEdge) / 1600
  const { fw, fh } = fieldDimsFor(layout.w, layout.h)
  const field = await edgeVectorField(referencePath, fw, fh)
  const cm = contourMosaic(layout.w, layout.h, tileSize, field)
  console.log(
    `Laid ${cm.count} contour tiles at size ${tileSize.toFixed(1)}px over ` +
      `${Math.round(layout.w)}x${Math.round(layout.h)}`
  )

  const cellSigs = await referenceWindowSignatures(
    referencePath,
    cm.centers,
    cm.tileSize,
    layout.w,
    layout.h
  )

  // ---- Opening cell: nearest tile center to the zoom focus -------------------
  const { focusX, focusY } = CONFIG.mosaic
  const fx = layout.w * focusX
  const fy = layout.h * focusY
  let openingCell = 0
  let openingDist = Infinity
  for (let i = 0; i < cm.count; i++) {
    const dx = cm.centers[i * 2] - fx
    const dy = cm.centers[i * 2 + 1] - fy
    const d = dx * dx + dy * dy
    if (d < openingDist) {
      openingDist = d
      openingCell = i
    }
  }

  // The opening cell fills the whole screen at t=0, so prefer the curated
  // hero/fan sources for it; everything else matches in cell order like the
  // page worker.
  const openingTiles = new Set(
    pool
      .map((tile, t) => ({ tile, t }))
      .filter(({ tile }) => tile.tier === "hero" || tile.tier === "fan")
      .map(({ t }) => t)
  )
  const order = [
    openingCell,
    ...Array.from({ length: cm.count }, (_, i) => i).filter(
      (i) => i !== openingCell
    ),
  ]
  const { assignment, errors } = matchCells({
    cellSigs,
    order,
    pool,
    eligibleByCell: (cell) =>
      cell === openingCell && openingTiles.size ? openingTiles : null,
  })

  // ---- Pack geometry in world (canvas) coordinates ---------------------------
  const polys = new Float32Array(cm.polys.length)
  for (let v = 0; v < cm.polys.length / 2; v++) {
    polys[v * 2] = cm.polys[v * 2] + layout.x
    polys[v * 2 + 1] = cm.polys[v * 2 + 1] + layout.y
  }
  const centers = new Float32Array(cm.centers.length)
  for (let i = 0; i < cm.count; i++) {
    centers[i * 2] = cm.centers[i * 2] + layout.x
    centers[i * 2 + 1] = cm.centers[i * 2 + 1] + layout.y
  }
  const bboxes = cellBBoxes(polys, cm.offsets, cm.count)

  // ---- Assignments + used-candidate manifest ---------------------------------
  const { preRollSec } = CONFIG.mosaic
  const usage = new Map()
  const assignments = new Array(cm.count)
  for (let cell = 0; cell < cm.count; cell++) {
    const tile = pool[assignment[cell]]
    usage.set(tile.key, (usage.get(tile.key) ?? 0) + 1)
    assignments[cell] = {
      cellIndex: cell,
      hero: cell === openingCell,
      error: errors[cell],
      candidateKey: tile.key,
      videoId: tile.videoId,
      tier: tile.tier,
      keyT: tile.t,
      startT: tile.t === null ? null : Math.max(0, tile.t - preRollSec),
      framePath: tile.framePath,
    }
  }
  const usedCandidates = pool
    .filter((tile) => usage.has(tile.key))
    .map((tile) => ({
      key: tile.key,
      videoId: tile.videoId,
      tier: tile.tier,
      t: tile.t,
      startT: tile.t === null ? null : Math.max(0, tile.t - preRollSec),
      framePath: tile.framePath,
      uses: usage.get(tile.key),
    }))

  await writeJson(CONFIG.paths.matchPath, {
    profile: CONFIG.profileName,
    generatedAt: new Date().toISOString(),
    referencePath,
    grid: {
      outputWidth: CONFIG.mosaic.outputWidth,
      outputHeight: CONFIG.mosaic.outputHeight,
      mosaicRect: { x: layout.x, y: layout.y, w: layout.w, h: layout.h },
      reference: { width: refMeta.width, height: refMeta.height },
      tileSize: cm.tileSize,
      openingCell,
    },
    geometry: encodeGeometry({
      count: cm.count,
      tileSize: cm.tileSize,
      polys,
      offsets: cm.offsets,
      angles: cm.angles,
      centers,
      bboxes,
    }),
    timing: {
      fps: CONFIG.mosaic.fps,
      tileFps: CONFIG.mosaic.tileFps,
      preRollSec: CONFIG.mosaic.preRollSec,
      freezeSec: CONFIG.mosaic.freezeSec,
    },
    assignments,
    usedCandidates,
  })

  console.log(
    `Matched ${assignments.length} cells using ${usedCandidates.length} unique tiles ` +
      `(reuse cap ${CONFIG.mosaic.tileReuseCap}).`
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
