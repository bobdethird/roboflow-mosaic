import { spawn } from "node:child_process"

import { CONFIG } from "../config.mjs"
import { clamp, run } from "./common.mjs"

const MIN_DB = -100

function roundTime(value) {
  return Number(value.toFixed(3))
}

async function decodeAudioEnvelope(videoPath) {
  const { sampleRate, envelopeWindowSec } = CONFIG.segmentation
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    videoPath,
    "-vn",
    "-ac",
    "1",
    "-ar",
    String(sampleRate),
    "-f",
    "f32le",
    "pipe:1",
  ]

  const chunks = []
  let stderr = ""
  await new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] })
    child.stdout.on("data", (chunk) => chunks.push(chunk))
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve()
      else
        reject(
          new Error(stderr.trim() || `ffmpeg audio decode failed (${code})`)
        )
    })
  })

  const audio = Buffer.concat(chunks)
  if (!audio.length) return []
  const arrayBuffer = audio.buffer.slice(
    audio.byteOffset,
    audio.byteOffset + audio.byteLength - (audio.byteLength % 4)
  )
  const samples = new Float32Array(arrayBuffer)
  const windowSamples = Math.max(1, Math.round(sampleRate * envelopeWindowSec))
  const envelope = []

  for (let start = 0; start < samples.length; start += windowSamples) {
    const end = Math.min(samples.length, start + windowSamples)
    let sumSq = 0
    for (let i = start; i < end; i++) sumSq += samples[i] * samples[i]
    const rms = Math.sqrt(sumSq / Math.max(1, end - start))
    const db = rms > 0 ? 20 * Math.log10(rms) : MIN_DB
    envelope.push({
      start: start / sampleRate,
      end: end / sampleRate,
      t: (start + end) / 2 / sampleRate,
      db: clamp(db, MIN_DB, 0),
    })
  }

  return envelope
}

async function ffmpegSilenceBoundaries(videoPath) {
  const { silenceNoiseDb, silenceMinDur } = CONFIG.segmentation
  const result = await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostats",
      "-i",
      videoPath,
      "-vn",
      "-af",
      `silencedetect=noise=${silenceNoiseDb}dB:d=${silenceMinDur}`,
      "-f",
      "null",
      "-",
    ],
    { quiet: true, allowFailure: true }
  )
  if (result.code !== 0) return []

  const boundaries = []
  let start = null
  for (const line of result.stderr.split("\n")) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/)
    if (startMatch) {
      start = Number(startMatch[1])
      continue
    }
    const endMatch = line.match(/silence_end:\s*([0-9.]+)/)
    if (endMatch && start !== null) {
      const end = Number(endMatch[1])
      boundaries.push((start + end) / 2)
      start = null
    }
  }

  return boundaries
}

function envelopeSilenceBoundaries(envelope) {
  const { silenceNoiseDb, silenceMinDur } = CONFIG.segmentation
  const boundaries = []
  let start = null

  for (const point of envelope) {
    const silent = point.db <= silenceNoiseDb
    if (silent && start === null) start = point.start
    if (!silent && start !== null) {
      if (point.start - start >= silenceMinDur) {
        boundaries.push((start + point.start) / 2)
      }
      start = null
    }
  }

  if (start !== null) {
    const end = envelope.at(-1)?.end ?? start
    if (end - start >= silenceMinDur) boundaries.push((start + end) / 2)
  }

  return boundaries
}

function loudnessStepBoundaries(envelope) {
  const { loudnessStepDb } = CONFIG.segmentation
  const boundaries = []
  for (let i = 1; i < envelope.length; i++) {
    const prev = envelope[i - 1]
    const curr = envelope[i]
    if (prev.db <= MIN_DB + 1 || curr.db <= MIN_DB + 1) continue
    if (Math.abs(curr.db - prev.db) >= loudnessStepDb) {
      boundaries.push(curr.start)
    }
  }
  return boundaries
}

function normalizeBoundaries(boundaries, duration) {
  const { minSegSec } = CONFIG.segmentation
  const sorted = [...new Set(boundaries.map(roundTime))]
    .filter((t) => t >= minSegSec && t <= duration - minSegSec)
    .sort((a, b) => a - b)
  const out = []
  for (const boundary of sorted) {
    if (!out.length || boundary - out.at(-1) >= minSegSec) out.push(boundary)
  }
  return out
}

function peakInRange(envelope, start, end) {
  let peak = null
  for (const point of envelope) {
    if (point.t < start || point.t > end) continue
    if (!peak || point.db > peak.db) peak = point
  }
  return peak
}

function makeSegment(envelope, start, end, source) {
  const peak = peakInRange(envelope, start, end)
  const keyT =
    CONFIG.segmentation.keyFrameMode === "loudnessPeak" && peak
      ? peak.t
      : Math.max(start, end - 0.25)
  return {
    start: roundTime(start),
    end: roundTime(end),
    keyT: roundTime(clamp(keyT, start, end)),
    sceneScore: null,
    loudnessDb: peak ? Number(peak.db.toFixed(2)) : null,
    source,
  }
}

function splitLongRange(envelope, start, end) {
  const { maxSegSec } = CONFIG.segmentation
  const segments = []
  for (let cursor = start; cursor < end; cursor += maxSegSec) {
    segments.push(
      makeSegment(envelope, cursor, Math.min(end, cursor + maxSegSec), "audio")
    )
  }
  return segments
}

export function fixedIntervalSegments(video) {
  const duration = Number(video.duration ?? video.durationSec ?? 0)
  const { preRollSec, minFillerSepSec, maxCandidatesPerFillerVideo } =
    CONFIG.mosaic
  const { minSegSec, maxSegSec } = CONFIG.segmentation
  if (!duration || duration < preRollSec + minSegSec) return []

  const first = preRollSec
  const last = Math.max(first, duration - 1)
  const span = last - first
  const count = Math.max(
    1,
    Math.min(
      maxCandidatesPerFillerVideo,
      Math.floor(span / minFillerSepSec) + 1
    )
  )
  const segments = []
  for (let i = 0; i < count; i++) {
    const keyT =
      count === 1 ? first : first + (span * i) / Math.max(1, count - 1)
    const start = Math.max(0, keyT - Math.min(maxSegSec, preRollSec))
    const end = Math.min(duration, Math.max(start + minSegSec, keyT + 1))
    segments.push({
      start: roundTime(start),
      end: roundTime(end),
      keyT: roundTime(keyT),
      sceneScore: null,
      loudnessDb: null,
      source: "fixed",
    })
  }
  return segments
}

function selectSegments(video, segments) {
  const { preRollSec, maxCandidatesPerFillerVideo } = CONFIG.mosaic
  const usable = segments.filter(
    (segment) =>
      segment.keyT >= preRollSec &&
      segment.end - segment.start >= CONFIG.segmentation.minSegSec
  )
  const tooFew =
    Number(video.duration ?? video.durationSec ?? 0) > 60 && usable.length < 3
  const tooMany =
    usable.length >
    Math.max(
      10,
      Math.ceil(Number(video.duration ?? 0) / CONFIG.segmentation.minSegSec)
    )

  if (!usable.length || tooFew || tooMany) return fixedIntervalSegments(video)

  return usable
    .sort((a, b) => (b.loudnessDb ?? MIN_DB) - (a.loudnessDb ?? MIN_DB))
    .slice(0, maxCandidatesPerFillerVideo)
    .sort((a, b) => a.keyT - b.keyT)
}

export async function segmentVideo(video) {
  if (video.tier === "hero" && video.chapters?.length) return []

  let envelope
  try {
    envelope = await decodeAudioEnvelope(video.path)
  } catch (error) {
    console.warn(`  audio analysis unavailable: ${error.message}`)
    return fixedIntervalSegments(video)
  }
  if (!envelope.length) return fixedIntervalSegments(video)

  const duration =
    Number(video.duration ?? video.durationSec ?? 0) ||
    envelope.at(-1)?.end ||
    0
  const boundaries = normalizeBoundaries(
    [
      ...(await ffmpegSilenceBoundaries(video.path)),
      ...envelopeSilenceBoundaries(envelope),
      ...loudnessStepBoundaries(envelope),
    ],
    duration
  )
  const edges = [0, ...boundaries, duration]
  const rawSegments = []
  for (let i = 0; i < edges.length - 1; i++) {
    const start = edges[i]
    const end = edges[i + 1]
    if (end - start < CONFIG.segmentation.minSegSec) continue
    if (end - start > CONFIG.segmentation.maxSegSec) {
      rawSegments.push(...splitLongRange(envelope, start, end))
    } else {
      rawSegments.push(makeSegment(envelope, start, end, "audio"))
    }
  }

  return selectSegments(video, rawSegments)
}
