import { fileURLToPath } from "node:url"
import path from "node:path"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, "../..")
const dataDir = path.join(__dirname, "data")

export const HERO_URLS = [
  "https://www.youtube.com/watch?v=biCFAgYwiig",
  "https://www.youtube.com/watch?v=XTWy-gAI99s",
  "https://www.youtube.com/watch?v=9zQREzDgnVE",
  "https://www.youtube.com/watch?v=rBwg2uASTzs",
  "https://www.youtube.com/watch?v=Jsj8Lyi1Pi4",
]

export const FAN_URLS = ["https://www.youtube.com/watch?v=1SxhKOeJ6dQ"]

export const CURATED_CHANNELS = [
  "https://www.youtube.com/@nyknicks/videos",
  "https://www.youtube.com/@MSGNetworks/videos",
  "https://www.youtube.com/@NBA/videos",
  "https://www.youtube.com/@Houseofhighlights/videos",
]

export const TIER2_SEARCHES = [
  "ytsearch8:New York Knicks highlights 2024",
  "ytsearch8:New York Knicks top plays",
  "ytsearch8:Jalen Brunson Knicks highlights",
  "ytsearch8:Knicks playoff highlights",
]

export const TIER2_URLS = []

export const GAMEPLAY_QUERY_MATRIX = {
  players: [
    "Jalen Brunson",
    "Karl-Anthony Towns",
    "OG Anunoby",
    "Mikal Bridges",
    "Josh Hart",
    "Julius Randle",
    "Donte DiVincenzo",
    "Mitchell Robinson",
    "RJ Barrett",
    "Carmelo Anthony",
    "Patrick Ewing",
  ],
  actions: [
    "game winner",
    "clutch three",
    "poster dunk",
    "block",
    "crossover",
    "buzzer beater",
    "career high",
    "best plays",
  ],
  seasons: ["2023", "2024", "2025", "2026", "playoffs"],
  generic: [
    "New York Knicks highlights",
    "Knicks top plays",
    "Knicks full game highlights",
    "Knicks clutch moments",
    "MSG Knicks highlights",
  ],
}

export const FAN_QUERY_MATRIX = {
  queries: [
    "Knicks watch party",
    "Knicks fans go crazy",
    "Knicks fans react",
    "MSG crowd erupts Knicks",
    "Knicks fans NYC celebration",
    "Knicks bar reaction",
    "Knicks fans storm streets",
    "Knicks crowd reaction",
    // Night street footage: the main source of genuinely dark tiles that
    // broadcast court footage never produces.
    "Knicks fans celebrate streets night",
    "Knicks fans Times Square",
    "Knicks fans outside MSG",
    "NYC celebrates Knicks win night",
    // Daylight parade/confetti footage: the main source of bright tiles.
    "Knicks championship parade",
    "Knicks parade Canyon of Heroes",
    "Knicks fans celebration daytime NYC",
  ],
  seasons: ["2024", "2025", "2026", "playoffs", "NBA Finals"],
}

const PROFILES = {
  prototype: {
    outputWidth: 3840,
    outputHeight: 2160,
    fps: 30,
    gridCols: 96,
    gridRows: 96,
    openingCols: 1,
    openingRows: 1,
    preRollSec: 28,
    freezeSec: 4,
    tileFps: 10,
    tileLongEdge: 160,
    tileOversample: 2,
    tier2MaxVideos: 16,
    fanMaxVideos: 8,
    targetCandidatePool: 240,
    poolSafetyMargin: 1.5,
    maxCandidatesPerFillerVideo: 300,
    maxHeroCandidates: 300,
    maxUniqueClips: 2000,
    maxReusePerClip: 64,
    playStartStagger: 0.5,
    encodePreset: "veryfast",
    crf: 20,
  },
  final: {
    outputWidth: 3840,
    outputHeight: 2160,
    fps: 30,
    gridCols: 64,
    gridRows: 64,
    openingCols: 1,
    openingRows: 1,
    preRollSec: 20,
    freezeSec: 4,
    tileFps: 15,
    tileLongEdge: 224,
    tileOversample: 2,
    tier2MaxVideos: 90,
    fanMaxVideos: 30,
    targetCandidatePool: 1000,
    poolSafetyMargin: 1.5,
    maxCandidatesPerFillerVideo: 120,
    maxHeroCandidates: 240,
    maxUniqueClips: 1200,
    encodePreset: "veryfast",
    crf: 18,
  },
}

const profileName = process.env.KNICKS_PROFILE || "prototype"
const profile = PROFILES[profileName] ?? PROFILES.prototype

export const CONFIG = {
  profileName,
  repoRoot,
  dataDir,
  paths: {
    videosDir: path.join(dataDir, "videos"),
    metadataDir: path.join(dataDir, "metadata"),
    framesDir: path.join(dataDir, "candidate-frames"),
    indexesDir: path.join(dataDir, "indexes"),
    segmentsDir: path.join(dataDir, "segments"),
    clipsDir: path.join(dataDir, "clips"),
    renderFramesDir: path.join(dataDir, "render-frames"),
    photoFramesDir: path.join(dataDir, "photo-frames"),
    referencePath: path.join(dataDir, "reference.png"),
    sourcesPath: path.join(dataDir, "sources.json"),
    indexPath: path.join(dataDir, "index.json"),
    matchPath: path.join(dataDir, "plan.json"),
    clipsPath: path.join(dataDir, "clips.json"),
    outputVideoPath: path.join(repoRoot, "public/knicks/knicks-mosaic.mp4"),
    posterPath: path.join(repoRoot, "public/knicks/poster.png"),
    publicReferencePath: path.join(repoRoot, "public/knicks/reference.png"),
    downloadArchivePath: path.join(dataDir, "archive.txt"),
  },
  scrape: {
    heroUrls: HERO_URLS,
    fanUrls: FAN_URLS,
    tier2Searches: TIER2_SEARCHES,
    tier2Urls: TIER2_URLS,
    channels: CURATED_CHANNELS,
    gameplayQueryMatrix: GAMEPLAY_QUERY_MATRIX,
    fanQueryMatrix: FAN_QUERY_MATRIX,
    perQueryMax: 8,
    // Per-fan-query take. Kept small so one query family can't fill the whole
    // fan quota — diversity across scenes matters more than depth per query.
    fanQueriesMax: 3,
    perChannelMax: 30,
    tier2MaxVideos: profile.tier2MaxVideos,
    fanMaxVideos: profile.fanMaxVideos,
    targetCandidatePool: profile.targetCandidatePool,
    poolSafetyMargin: profile.poolSafetyMargin,
    minDurationSec: 60,
    minShortClipDurationSec: 25,
    maxDurationSec: 30 * 60,
    fanMaxDurationSec: 30 * 60,
    minHeight: 720,
    dropShorts: true,
    titleAllow: [
      /knicks/i,
      /\bnyk\b/i,
      /brunson/i,
      /anunoby/i,
      /bridges/i,
      /hart/i,
      /towns/i,
      /randle/i,
      /divincenzo/i,
      /ewing/i,
      /carmelo/i,
      /msg/i,
      /watch party/i,
      /fans?/i,
      /crowd/i,
      /nyc/i,
    ],
    titleBlock: [
      /nba 2k/i,
      /podcast/i,
      /rumou?r/i,
      /trade/i,
      /mock draft/i,
      /reaction to highlights/i,
    ],
    specialClipTitleAllow: [
      /game.?winner/i,
      /buzzer/i,
      /clutch/i,
      /fans? go/i,
      /crowd/i,
      /watch party/i,
      /reaction/i,
    ],
    cookiesFromBrowser: process.env.KNICKS_YTDLP_COOKIES_FROM_BROWSER || null,
    extractorArgs: process.env.KNICKS_YTDLP_EXTRACTOR_ARGS || null,
    sleepRequests: 1,
    sleepInterval: 2,
    maxSleepInterval: 6,
    retries: 3,
    fragmentRetries: 3,
  },
  mosaic: {
    outputWidth: profile.outputWidth,
    outputHeight: profile.outputHeight,
    fps: profile.fps,
    gridCols: profile.gridCols,
    gridRows: profile.gridRows,
    openingCols: profile.openingCols,
    openingRows: profile.openingRows,
    focusX: 0.5,
    focusY: 0.5,
    preRollSec: profile.preRollSec,
    freezeSec: profile.freezeSec,
    tileFps: profile.tileFps,
    tileLongEdge: profile.tileLongEdge,
    tileOversample: profile.tileOversample,
    chapterEndWindowSec: 5,
    minFillerSepSec: 20,
    maxCandidatesPerFillerVideo: profile.maxCandidatesPerFillerVideo,
    maxHeroCandidates: profile.maxHeroCandidates,
    maxUniqueClips: profile.maxUniqueClips,
    maxReusePerClip:
      Number(process.env.KNICKS_REUSE_CAP) || profile.maxReusePerClip || null,
    // Contour-flow tile geometry (mirrors the /knicks-mosaic page). `tileDensity`
    // is in the page's slider units (cell px on a 1600-long-edge canvas, default
    // 40); the actual output-pixel tile size scales with the mosaic rect's long
    // edge. KNICKS_TILE_SIZE (output px) overrides the density-derived size.
    tileDensity: Number(process.env.KNICKS_DENSITY) || 40,
    tileSizeOverride: Number(process.env.KNICKS_TILE_SIZE) || null,
    // Per-tile reuse cap for matching, mirroring the page's maxTileReuse (20 on
    // /knicks-mosaic). KNICKS_REUSE_CAP overrides.
    tileReuseCap: Number(process.env.KNICKS_REUSE_CAP) || 20,
    playStartStagger: profile.playStartStagger ?? 0,
    encodePreset: process.env.KNICKS_ENCODE_PRESET || profile.encodePreset,
    heroReuseCap: 2,
    crf: profile.crf,
  },
  // Standalone "photo mosaic" track (separate from the video mosaic above):
  // sample still frames from each source video and publish them as a regular
  // photo-mosaic library to a Supabase bucket. Consumed by the /knicks-mosaic
  // page via the existing mosaic engine.
  photo: {
    // Frames per second to sample from each video. 0.33 = about one frame every 3s.
    fps: Number(process.env.KNICKS_PHOTO_FPS) || 0.33,
    // Sampling multiplier for fan-tier videos (street/crowd/night footage).
    // Fan sources carry the rare dark and bright tiles the broadcast footage
    // lacks, so they are over-sampled relative to the base fps.
    fanFpsBoost: Number(process.env.KNICKS_PHOTO_FAN_FPS_BOOST) || 3,
    // Cap on frames kept per video (0 = unlimited). When set, the effective fps
    // is lowered so the cap's frames are spread evenly across the sampled window.
    maxPerVideo: Number(process.env.KNICKS_PHOTO_MAX_PER_VIDEO) || 0,
    // Seconds dropped from the end of each video before sampling — the tail is
    // usually an outro / "thanks for watching" card that makes a poor tile.
    // Set KNICKS_PHOTO_TAIL_TRIM=0 to keep it.
    tailTrimSec:
      process.env.KNICKS_PHOTO_TAIL_TRIM !== undefined &&
      process.env.KNICKS_PHOTO_TAIL_TRIM !== ""
        ? Number(process.env.KNICKS_PHOTO_TAIL_TRIM)
        : 10,
    // Seconds dropped from the start of each video (intros). Off by default.
    headTrimSec:
      process.env.KNICKS_PHOTO_HEAD_TRIM !== undefined &&
      process.env.KNICKS_PHOTO_HEAD_TRIM !== ""
        ? Number(process.env.KNICKS_PHOTO_HEAD_TRIM)
        : 0,
    // Drop near-flat frames whose luminance std-dev (over the 16×16 signature)
    // is below this — outro/"thanks for watching" cards, solid-color slates, and
    // black transitions. Real (even dark) gameplay/crowd frames measure well
    // above this, so it removes junk tiles without touching content. Set
    // KNICKS_PHOTO_FLATNESS_MIN=0 to disable.
    flatnessMinStd:
      process.env.KNICKS_PHOTO_FLATNESS_MIN !== undefined &&
      process.env.KNICKS_PHOTO_FLATNESS_MIN !== ""
        ? Number(process.env.KNICKS_PHOTO_FLATNESS_MIN)
        : 10,
    // Long edge (px) of each extracted frame. These frames double as the tile
    // "originals" (the hover/click preview on /knicks-mosaic), so keep them at
    // roughly source resolution; the extractor never upscales smaller sources.
    longEdge: Number(process.env.KNICKS_PHOTO_LONG_EDGE) || 1920,
    // Longest edge + JPEG quality of the uploaded thumbnails. Mirrors the
    // browser seeder (THUMB_MAX/THUMB_QUALITY) so libraries look identical.
    thumbMax: 200,
    thumbQuality: 82,
    // Skip videos whose ids start with these prefixes (synthetic test clips are
    // just color bars and make poor tiles).
    skipPrefixes: ["synthetic"],
    // Supabase Storage bucket the library is published to. Must also be listed
    // in MOSAIC_BUCKETS (lib/photo-library.ts) or the proxy rejects it.
    bucket: process.env.KNICKS_PHOTO_BUCKET || "knicks-mosaic",
  },
  segmentation: {
    silenceNoiseDb: -30,
    silenceMinDur: 0.25,
    loudnessStepDb: 7,
    envelopeWindowSec: 0.5,
    minSegSec: 2,
    maxSegSec: 4,
    keyFrameMode: "loudnessPeak",
    useSceneCuts: false,
    sceneThreshold: 0.4,
    sampleRate: 1000,
  },
}
