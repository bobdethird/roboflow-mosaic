// Deterministic photo-frame sampling parameters, shared by photo-frames.mjs
// (which extracts the frames) and 03-match.mjs (which maps frame files back to
// source-video timestamps). Frame N (1-indexed) of a video sampled at `fps`
// starting at `startAt` sits at t ≈ startAt + (N - 1) / fps.

import { CONFIG } from "../config.mjs"
import { captureJson } from "./common.mjs"

export async function probeDuration(videoPath) {
  try {
    const info = await captureJson("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      videoPath,
    ])
    const duration = Number(info?.format?.duration)
    return Number.isFinite(duration) && duration > 0 ? duration : null
  } catch {
    return null
  }
}

// Frames/sec to sample so a `maxPerVideo` cap (if any) is spread evenly across
// the sampled window without ever exceeding the configured base fps.
export function fpsForWindow(windowSec, boost = 1) {
  const base = CONFIG.photo.fps * boost
  const cap = CONFIG.photo.maxPerVideo
  if (!cap || cap <= 0 || !windowSec || windowSec <= 0) return base
  return Math.max(Math.min(base, cap / windowSec), 1e-4)
}

// The sampled window and effective fps for one source video — the exact values
// photo-frames.mjs feeds ffmpeg, recomputable from the video alone so frames
// extracted before the manifest existed still map back to timestamps.
export function samplingParams(duration, tier) {
  const headTrim = Math.max(0, CONFIG.photo.headTrimSec || 0)
  const tailTrim = Math.max(0, CONFIG.photo.tailTrimSec || 0)
  let startAt = 0
  let window = null
  if (duration && duration > headTrim + tailTrim + 0.5) {
    startAt = headTrim
    window = duration - headTrim - tailTrim
  }
  const boost = tier === "fan" ? CONFIG.photo.fanFpsBoost : 1
  const fps = fpsForWindow(window ?? duration, boost)
  return { startAt, window, fps }
}
