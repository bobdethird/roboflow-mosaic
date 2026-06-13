import fs from "node:fs/promises"
import path from "node:path"

import { CONFIG } from "./config.mjs"
import {
  buildGridGeometry,
  openingCellForCenters,
  openingCellForGrid,
} from "./lib/grid.mjs"
import {
  cellBBoxes,
  contourMosaic,
  encodeGeometry,
} from "./lib/contour.mjs"
import { ensureDir, readJson, shortHash, writeJson } from "./lib/common.mjs"
import {
  averageColor,
  edgeVectorField,
  fieldDimsFor,
  probeImage,
  referenceCellSignatures,
  referenceWindowSignatures,
  resolveReferencePath,
} from "./lib/media.mjs"
import {
  COARSE_CHANNELS,
  COARSE_LEN,
  downsampleSig,
  lumStd,
  meanRgb,
  SIG_BYTES,
} from "./lib/signature.mjs"

const DUP_MIN_DIST_PITCHES = 6

function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--") continue
    if (arg === "--reference") args.reference = argv[++i]
    else if (arg === "--layout") args.layout = argv[++i]
    else if (arg === "--grid-cols") args.gridCols = Number(argv[++i])
    else if (arg === "--grid-rows") args.gridRows = Number(argv[++i])
    else if (arg === "--help") args.help = true
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

function usageText() {
  return `Usage: node 02-match.mjs --reference <image> [--layout voronoi|grid] [--grid-cols N --grid-rows N]

Environment overrides: MOSAIC_PROFILE, MOSAIC_LAYOUT, MOSAIC_DENSITY, MOSAIC_TILE_SIZE,
MOSAIC_REUSE_CAP, MOSAIC_MIN_SAME_VIDEO_GAP_SEC, MOSAIC_FLATNESS_MIN,
MOSAIC_REQUIRE_FULL_PREROLL.`
}

function frameTime(video, frameIndex) {
  return frameIndex / video.sampleFps
}

function buildCandidatePool({ manifest, signatures }) {
  const pool = []
  const requireFullPreroll = CONFIG.mosaic.requireFullPreroll
  let droppedFlat = 0
  let droppedEarly = 0

  for (const video of manifest.videos ?? []) {
    for (let i = 0; i < video.frameCount; i++) {
      const globalFrame = video.frameOffset + i
      const start = globalFrame * SIG_BYTES
      const sig = signatures.subarray(start, start + SIG_BYTES)
      if (sig.length !== SIG_BYTES) {
        throw new Error(`Invalid signature slice for ${video.videoId} frame ${i}`)
      }
      if (lumStd(sig) < CONFIG.mosaic.flatnessMinStd) {
        droppedFlat++
        continue
      }
      const t = frameTime(video, i)
      if (requireFullPreroll && t < CONFIG.mosaic.preRollSec) {
        droppedEarly++
        continue
      }
      const coarse = downsampleSig(sig)
      const [r, g, b] = meanRgb(coarse)
      pool.push({
        index: pool.length,
        key: `${video.videoId}_${String(i).padStart(6, "0")}`,
        videoId: video.videoId,
        videoPath: path.resolve(CONFIG.pipelineRoot, video.path),
        sourcePath: video.path,
        sourceHash: video.contentHash,
        sourceWidth: video.width,
        sourceHeight: video.height,
        frameIndex: i,
        keyT: t,
        startT: Math.max(0, t - CONFIG.mosaic.preRollSec),
        matchAtSec: t - Math.max(0, t - CONFIG.mosaic.preRollSec),
        coarse,
        mean: [r, g, b],
      })
    }
  }

  if (pool.length === 0 && requireFullPreroll) {
    console.warn(
      "No candidates survived the full-preroll filter; retrying with early frames allowed."
    )
    const previous = CONFIG.mosaic.requireFullPreroll
    CONFIG.mosaic.requireFullPreroll = false
    const retry = buildCandidatePool({ manifest, signatures })
    CONFIG.mosaic.requireFullPreroll = previous
    return retry
  }

  console.log(
    `Pool: ${pool.length} candidates (${droppedFlat} flat, ${droppedEarly} before preroll dropped)`
  )
  return pool
}

function matchCells({ cellSigs, geometry, pool, order }) {
  if (!pool.length) throw new Error("No frame candidates available for matching.")

  const reuseCap = Math.max(0, Math.floor(CONFIG.mosaic.tileReuseCap || 0))
  const maxUniqueClips = Math.max(0, Math.floor(CONFIG.mosaic.maxUniqueClips || 0))
  const nTiles = pool.length
  const means = new Float32Array(nTiles * 3)
  for (let t = 0; t < nTiles; t++) {
    means[t * 3] = pool[t].mean[0]
    means[t * 3 + 1] = pool[t].mean[1]
    means[t * 3 + 2] = pool[t].mean[2]
  }

  const useCounts = new Uint32Array(nTiles)
  const usedUnique = new Set()
  const mds = new Float32Array(nTiles)
  const assignment = new Int32Array(cellSigs.length).fill(-1)
  const errors = new Float32Array(cellSigs.length)
  const pitch = Math.sqrt(
    (geometry.width * geometry.height) / Math.max(1, cellSigs.length)
  )
  const dupMinDist2 =
    DUP_MIN_DIST_PITCHES * pitch * (DUP_MIN_DIST_PITCHES * pitch)
  const placements = new Array(nTiles)
  const usedTimesByVideo = new Map()

  for (const cell of order) {
    const cs = downsampleSig(cellSigs[cell])
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
      const dr = cr - means[t * 3]
      const dg = cg - means[t * 3 + 1]
      const db = cb - means[t * 3 + 2]
      mds[t] = dr * dr + dg * dg + db * db
    }

    const px = geometry.centers[cell * 2]
    const py = geometry.centers[cell * 2 + 1]
    const tooCloseSpatially = (tileIndex) => {
      const placed = placements[tileIndex]
      if (!placed) return false
      for (let i = 0; i < placed.length; i += 2) {
        const dx = placed[i] - px
        const dy = placed[i + 1] - py
        if (dx * dx + dy * dy < dupMinDist2) return true
      }
      return false
    }
    const tooCloseInTime = (tileIndex) => {
      const tile = pool[tileIndex]
      const used = usedTimesByVideo.get(tile.videoId)
      if (!used) return false
      for (const entry of used) {
        if (entry.tileIndex === tileIndex) continue
        if (
          Math.abs(entry.keyT - tile.keyT) <
          CONFIG.mosaic.minSameVideoGapSec
        ) {
          return true
        }
      }
      return false
    }
    const blockedAt = (tileIndex, level) => {
      if (level < 3) {
        if (reuseCap && useCounts[tileIndex] >= reuseCap) return true
        if (
          maxUniqueClips &&
          usedUnique.size >= maxUniqueClips &&
          !usedUnique.has(tileIndex)
        ) {
          return true
        }
      }
      if (level < 2 && tooCloseInTime(tileIndex)) return true
      if (level < 1 && tooCloseSpatially(tileIndex)) return true
      return false
    }

    let seed = -1
    let seedDist = Infinity
    let level = 0
    for (; level <= 3; level++) {
      seed = -1
      seedDist = Infinity
      for (let t = 0; t < nTiles; t++) {
        if (blockedAt(t, level)) continue
        if (mds[t] < seedDist) {
          seedDist = mds[t]
          seed = t
        }
      }
      if (seed >= 0) break
    }
    if (seed < 0) {
      throw new Error(`No candidate found for cell ${cell}`)
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
      if (blockedAt(t, level)) continue
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
    const placed = placements[best] ?? (placements[best] = [])
    placed.push(px, py)
    const tile = pool[best]
    const times = usedTimesByVideo.get(tile.videoId) ?? []
    times.push({ keyT: tile.keyT, tileIndex: best })
    usedTimesByVideo.set(tile.videoId, times)
  }

  return { assignment, errors }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usageText())
    return
  }

  const referencePath = await resolveReferencePath(args.reference)
  const [manifest, signatures, reference] = await Promise.all([
    readJson(CONFIG.paths.indexManifestPath),
    fs.readFile(CONFIG.paths.indexSignaturesPath),
    probeImage(referencePath),
  ])
  if (!manifest?.videos?.length) {
    throw new Error("Missing frame index. Run python3 01-index-frames.py first.")
  }
  if (signatures.length !== manifest.frameCount * SIG_BYTES) {
    throw new Error(
      `Signature blob has ${signatures.length} bytes; expected ${
        manifest.frameCount * SIG_BYTES
      }.`
    )
  }

  const layout = args.layout || CONFIG.mosaic.layout
  if (layout !== "grid" && layout !== "voronoi") {
    throw new Error(`Unknown layout "${layout}" (use voronoi or grid)`)
  }
  const { outputWidth, outputHeight } = CONFIG.mosaic
  const pool = buildCandidatePool({ manifest, signatures })

  let gridCols = null
  let gridRows = null
  let geometry
  let cellSigs
  let cellCount
  let contour = null
  let packedGeometry = null
  if (layout === "voronoi") {
    // Tile size in output px: density is in the web page's slider units
    // (cell px on a 1600-long-edge canvas).
    const longEdge = Math.max(outputWidth, outputHeight)
    const tileSize =
      CONFIG.mosaic.tileSizeOverride ||
      (CONFIG.mosaic.tileDensity * longEdge) / 1600
    const { fw, fh } = fieldDimsFor(outputWidth, outputHeight)
    const field = await edgeVectorField(referencePath, fw, fh)
    contour = contourMosaic(outputWidth, outputHeight, tileSize, field)
    cellCount = contour.count
    console.log(
      `Laid ${cellCount} contour-flow Voronoi tiles at size ${tileSize.toFixed(1)}px`
    )
    cellSigs = await referenceWindowSignatures(
      referencePath,
      contour.centers,
      contour.tileSize,
      outputWidth,
      outputHeight
    )
    geometry = {
      centers: contour.centers,
      width: outputWidth,
      height: outputHeight,
    }
    packedGeometry = encodeGeometry({
      ...contour,
      bboxes: cellBBoxes(contour.polys, contour.offsets, contour.count),
    })
  } else {
    gridCols = args.gridCols || CONFIG.mosaic.gridCols
    gridRows = args.gridRows || CONFIG.mosaic.gridRows
    cellCount = gridCols * gridRows
    geometry = buildGridGeometry({ cols: gridCols, rows: gridRows })
    cellSigs = await referenceCellSignatures(referencePath, gridCols, gridRows)
  }

  const openingCell =
    layout === "voronoi"
      ? openingCellForCenters(geometry.centers, outputWidth, outputHeight)
      : openingCellForGrid(geometry)
  const order = [
    openingCell,
    ...Array.from({ length: cellCount }, (_, i) => i).filter(
      (i) => i !== openingCell
    ),
  ]
  const { assignment, errors } = matchCells({ cellSigs, geometry, pool, order })

  const usage = new Map()
  const assignments = Array.from({ length: assignment.length }, (_, cell) => {
    const tile = pool[assignment[cell]]
    usage.set(tile.key, (usage.get(tile.key) ?? 0) + 1)
    return {
      cellIndex: cell,
      row: gridCols ? Math.floor(cell / gridCols) : null,
      col: gridCols ? cell % gridCols : null,
      hero: cell === openingCell,
      error: errors[cell],
      candidateKey: tile.key,
      videoId: tile.videoId,
      videoPath: tile.videoPath,
      sourcePath: tile.sourcePath,
      sourceHash: tile.sourceHash,
      sourceWidth: tile.sourceWidth,
      sourceHeight: tile.sourceHeight,
      frameIndex: tile.frameIndex,
      keyT: tile.keyT,
      startT: tile.startT,
      matchAtSec: tile.matchAtSec,
    }
  })
  const usedCandidates = pool
    .filter((tile) => usage.has(tile.key))
    .map((tile) => ({
      key: tile.key,
      videoId: tile.videoId,
      videoPath: tile.videoPath,
      sourcePath: tile.sourcePath,
      sourceHash: tile.sourceHash,
      sourceWidth: tile.sourceWidth,
      sourceHeight: tile.sourceHeight,
      frameIndex: tile.frameIndex,
      keyT: tile.keyT,
      startT: tile.startT,
      matchAtSec: tile.matchAtSec,
      uses: usage.get(tile.key),
    }))

  const plan = {
    schemaVersion: 1,
    profile: CONFIG.profileName,
    generatedAt: new Date().toISOString(),
    referencePath,
    index: {
      manifestPath: CONFIG.paths.indexManifestPath,
      signaturesPath: CONFIG.paths.indexSignaturesPath,
      manifestHash: shortHash(JSON.stringify(manifest)),
      sampleFps: manifest.sampleFps,
    },
    grid: {
      layout,
      outputWidth: CONFIG.mosaic.outputWidth,
      outputHeight: CONFIG.mosaic.outputHeight,
      gridCols,
      gridRows,
      cellWidth: geometry.cellWidth ?? null,
      cellHeight: geometry.cellHeight ?? null,
      cellCount,
      tileSize: contour?.tileSize ?? null,
      openingCell,
      reference,
      backgroundColor: await averageColor(referencePath),
    },
    geometry: packedGeometry,
    timing: {
      fps: CONFIG.mosaic.fps,
      tileFps: CONFIG.mosaic.tileFps,
      preRollSec: CONFIG.mosaic.preRollSec,
      freezeSec: CONFIG.mosaic.freezeSec,
    },
    constraints: {
      tileReuseCap: CONFIG.mosaic.tileReuseCap,
      duplicateMinDistPitches: DUP_MIN_DIST_PITCHES,
      minSameVideoGapSec: CONFIG.mosaic.minSameVideoGapSec,
      flatnessMinStd: CONFIG.mosaic.flatnessMinStd,
      requireFullPreroll: CONFIG.mosaic.requireFullPreroll,
    },
    assignments,
    usedCandidates,
  }

  await ensureDir(path.dirname(CONFIG.paths.matchPath))
  await writeJson(CONFIG.paths.matchPath, plan)
  console.log(
    `Matched ${assignments.length} cells using ${usedCandidates.length} unique frame candidates.`
  )
  console.log(`Wrote ${CONFIG.paths.matchPath}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
