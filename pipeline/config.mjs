import path from "node:path"
import { fileURLToPath } from "node:url"

const pipelineRoot = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(pipelineRoot, "..")
const dataDir = path.join(pipelineRoot, "data")
const outputDir = path.join(pipelineRoot, "output")

const PROFILES = {
  prototype: {
    outputWidth: 3840,
    outputHeight: 2160,
    gridCols: 64,
    gridRows: 36,
    fps: 30,
    tileFps: 10,
    preRollSec: 28,
    freezeSec: 4,
    tileOversample: 2,
    tileReuseCap: 20,
    maxUniqueClips: 2000,
    minSameVideoGapSec: 4,
    playStartStagger: 0.5,
    encodePreset: "veryfast",
    crf: 20,
  },
  final: {
    outputWidth: 3840,
    outputHeight: 2160,
    gridCols: 96,
    gridRows: 54,
    fps: 30,
    tileFps: 15,
    preRollSec: 28,
    freezeSec: 4,
    tileOversample: 2,
    tileReuseCap: 20,
    maxUniqueClips: 3000,
    minSameVideoGapSec: 4,
    playStartStagger: 0.5,
    encodePreset: "veryfast",
    crf: 18,
  },
}

const profileName = process.env.MOSAIC_PROFILE || "prototype"
const profile = PROFILES[profileName] ?? PROFILES.prototype

function envNumber(name, fallback) {
  const value = process.env[name]
  if (value === undefined || value === "") return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export const CONFIG = {
  profileName,
  repoRoot,
  pipelineRoot,
  dataDir,
  outputDir,
  paths: {
    videosDir: path.join(pipelineRoot, "videos"),
    indexDir: path.join(dataDir, "index"),
    indexManifestPath: path.join(dataDir, "index", "manifest.json"),
    indexSignaturesPath: path.join(dataDir, "index", "signatures.bin"),
    referencePath: path.join(dataDir, "reference.png"),
    matchPath: path.join(dataDir, "plan.json"),
    clipsManifestPath: path.join(dataDir, "clips.json"),
    clipCacheDir: path.join(dataDir, "clip-cache"),
    renderFramesDir: path.join(dataDir, "render-frames"),
    renderMetaPath: path.join(dataDir, "render-frames", "latest.json"),
    outputVideoPath: path.join(outputDir, "mosaic.mp4"),
    posterPath: path.join(outputDir, "poster.jpg"),
  },
  mosaic: {
    // "voronoi" = contour-flow Voronoi cells (the web engine's layout);
    // "grid" = plain uniform grid.
    layout: process.env.MOSAIC_LAYOUT || "voronoi",
    // Voronoi tile size, in the web page's density units (cell px on a
    // 1600-long-edge canvas; default 40). MOSAIC_TILE_SIZE (output px) overrides.
    tileDensity: envNumber("MOSAIC_DENSITY", 40),
    tileSizeOverride: envNumber("MOSAIC_TILE_SIZE", 0),
    outputWidth: envNumber("MOSAIC_OUTPUT_WIDTH", profile.outputWidth),
    outputHeight: envNumber("MOSAIC_OUTPUT_HEIGHT", profile.outputHeight),
    gridCols: envNumber("MOSAIC_GRID_COLS", profile.gridCols),
    gridRows: envNumber("MOSAIC_GRID_ROWS", profile.gridRows),
    fps: envNumber("MOSAIC_FPS", profile.fps),
    tileFps: envNumber("MOSAIC_TILE_FPS", profile.tileFps),
    preRollSec: envNumber("MOSAIC_PREROLL_SEC", profile.preRollSec),
    freezeSec: envNumber("MOSAIC_FREEZE_SEC", profile.freezeSec),
    tileOversample: envNumber("MOSAIC_TILE_OVERSAMPLE", profile.tileOversample),
    tileReuseCap: envNumber("MOSAIC_REUSE_CAP", profile.tileReuseCap),
    maxUniqueClips: envNumber("MOSAIC_MAX_UNIQUE_CLIPS", profile.maxUniqueClips),
    minSameVideoGapSec: envNumber(
      "MOSAIC_MIN_SAME_VIDEO_GAP_SEC",
      profile.minSameVideoGapSec
    ),
    focusX: envNumber("MOSAIC_FOCUS_X", 0.5),
    focusY: envNumber("MOSAIC_FOCUS_Y", 0.5),
    playStartStagger: envNumber(
      "MOSAIC_PLAY_START_STAGGER",
      profile.playStartStagger
    ),
    encodePreset: process.env.MOSAIC_ENCODE_PRESET || profile.encodePreset,
    crf: envNumber("MOSAIC_CRF", profile.crf),
    flatnessMinStd: envNumber("MOSAIC_FLATNESS_MIN", 10),
    requireFullPreroll:
      process.env.MOSAIC_REQUIRE_FULL_PREROLL === undefined
        ? false
        : process.env.MOSAIC_REQUIRE_FULL_PREROLL !== "0",
  },
}
