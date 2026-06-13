import path from "node:path"

import { CONFIG } from "../config.mjs"
import {
  captureBuffer,
  captureJson,
  ensureDir,
  exists,
  formatSeconds,
  run,
} from "./common.mjs"
import { SIG_BYTES, SIGNATURE_GRID } from "./signature.mjs"

export async function probeVideo(videoPath) {
  const info = await captureJson("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "format=duration:stream=width,height,duration",
    "-of",
    "json",
    videoPath,
  ])
  const stream = info.streams?.[0]
  const width = Number(stream?.width)
  const height = Number(stream?.height)
  const duration = Number(info.format?.duration ?? stream?.duration)
  if (!width || !height) {
    throw new Error(`Could not probe video size for ${videoPath}`)
  }
  return { width, height, duration: Number.isFinite(duration) ? duration : null }
}

export async function probeImage(imagePath) {
  const info = await captureJson("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=width,height",
    "-of",
    "json",
    imagePath,
  ])
  const stream = info.streams?.[0]
  const width = Number(stream?.width)
  const height = Number(stream?.height)
  if (!width || !height) {
    throw new Error(`Could not probe image size for ${imagePath}`)
  }
  return { width, height }
}

export async function rawImageRgb(imagePath, width, height) {
  const result = await captureBuffer(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      imagePath,
      "-frames:v",
      "1",
      "-vf",
      `scale=${width}:${height}:flags=area,format=rgb24`,
      "-f",
      "rawvideo",
      "-pix_fmt",
      "rgb24",
      "-",
    ],
    { quiet: true }
  )
  const data = result.stdout
  const expected = width * height * 3
  if (data.length !== expected) {
    throw new Error(
      `Expected ${expected} RGB bytes from ${imagePath}, got ${data.length}`
    )
  }
  return data
}

export async function referenceCellSignatures(referencePath, cols, rows) {
  const width = cols * SIGNATURE_GRID
  const height = rows * SIGNATURE_GRID
  const data = await rawImageRgb(referencePath, width, height)
  const signatures = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const sig = new Uint8Array(SIG_BYTES)
      let dst = 0
      for (let y = 0; y < SIGNATURE_GRID; y++) {
        const srcY = row * SIGNATURE_GRID + y
        for (let x = 0; x < SIGNATURE_GRID; x++) {
          const srcX = col * SIGNATURE_GRID + x
          const src = (srcY * width + srcX) * 3
          sig[dst++] = data[src]
          sig[dst++] = data[src + 1]
          sig[dst++] = data[src + 2]
        }
      }
      signatures.push(sig)
    }
  }
  return signatures
}

// Edge-vector field dims, matching the web engine (long edge fixed at 360).
const FIELD_LONG_EDGE = 360

export function fieldDimsFor(w, h) {
  const aspect = w / h
  return aspect >= 1
    ? {
        fw: FIELD_LONG_EDGE,
        fh: Math.max(1, Math.round(FIELD_LONG_EDGE / aspect)),
      }
    : {
        fw: Math.max(1, Math.round(FIELD_LONG_EDGE * aspect)),
        fh: FIELD_LONG_EDGE,
      }
}

// Port of the web engine's `edgeVectorField`: normalized Sobel magnitude plus
// gradient direction over an fw×fh luminance grid of the reference.
export async function edgeVectorField(referencePath, fw, fh) {
  const data = await rawImageRgb(referencePath, fw, fh)
  const lum = new Float32Array(fw * fh)
  for (let i = 0; i < fw * fh; i++) {
    lum[i] =
      0.299 * data[i * 3] + 0.587 * data[i * 3 + 1] + 0.114 * data[i * 3 + 2]
  }
  const at = (x, y) => {
    const cx = x < 0 ? 0 : x >= fw ? fw - 1 : x
    const cy = y < 0 ? 0 : y >= fh ? fh - 1 : y
    return lum[cy * fw + cx]
  }
  const mag = new Float32Array(fw * fh)
  const dir = new Float32Array(fw * fh)
  let max = 1e-6
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const gx =
        at(x + 1, y - 1) +
        2 * at(x + 1, y) +
        at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))
      const gy =
        at(x - 1, y + 1) +
        2 * at(x, y + 1) +
        at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))
      const m = Math.hypot(gx, gy)
      mag[y * fw + x] = m
      dir[y * fw + x] = Math.atan2(gy, gx)
      if (m > max) max = m
    }
  }
  for (let i = 0; i < mag.length; i++) mag[i] /= max
  return { mag, dir, fw, fh }
}

// Port of the web engine's `referenceWindowSignatures`: per-tile 16×16×3
// signatures for arbitrary tile centers. The reference is rendered once into a
// buffer scaled so a `size`-px window maps to 16×16 buffer pixels, then each
// tile reads its block straight out of that buffer.
export async function referenceWindowSignatures(
  referencePath,
  centers,
  size,
  width,
  height
) {
  const s = SIGNATURE_GRID
  const n = centers.length / 2
  const scale = s / Math.max(1, size)
  const bw = Math.max(s, Math.round(width * scale))
  const bh = Math.max(s, Math.round(height * scale))
  const data = await rawImageRgb(referencePath, bw, bh)
  const clampI = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v)
  const half = s / 2
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    const sx0 = Math.round(centers[i * 2] * scale - half)
    const sy0 = Math.round(centers[i * 2 + 1] * scale - half)
    const sig = new Uint8Array(SIG_BYTES)
    for (let yy = 0; yy < s; yy++) {
      const py = clampI(sy0 + yy, bh - 1)
      for (let xx = 0; xx < s; xx++) {
        const px = clampI(sx0 + xx, bw - 1)
        const di = (py * bw + px) * 3
        const k = (yy * s + xx) * 3
        sig[k] = data[di]
        sig[k + 1] = data[di + 1]
        sig[k + 2] = data[di + 2]
      }
    }
    out[i] = sig
  }
  return out
}

// Mean pixel of the reference — used as the grout/background color.
export async function averageColor(referencePath) {
  const data = await rawImageRgb(referencePath, 1, 1)
  return `rgb(${data[0]}, ${data[1]}, ${data[2]})`
}

export function coverFrameSizeForSource(sourceSize, targetBox) {
  const oversample = CONFIG.mosaic.tileOversample || 1
  const targetWidth = Math.max(1, targetBox.width * oversample)
  const targetHeight = Math.max(1, targetBox.height * oversample)
  const scale = Math.max(
    targetWidth / sourceSize.width,
    targetHeight / sourceSize.height
  )
  return {
    width: Math.max(1, Math.min(sourceSize.width, Math.ceil(sourceSize.width * scale))),
    height: Math.max(
      1,
      Math.min(sourceSize.height, Math.ceil(sourceSize.height * scale))
    ),
  }
}

export async function resolveReferencePath(cliPath) {
  const referencePath = cliPath || process.env.MOSAIC_REFERENCE || CONFIG.paths.referencePath
  const absolute = path.resolve(referencePath)
  if (!(await exists(absolute))) {
    throw new Error(
      `Reference image not found: ${absolute}. Pass --reference <path> or set MOSAIC_REFERENCE.`
    )
  }
  return absolute
}

export async function extractVideoFrames({
  videoPath,
  startT,
  duration,
  fps,
  width,
  height,
  outDir,
}) {
  await ensureDir(outDir)
  const filter = [
    `fps=${fps}`,
    `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos`,
    "setsar=1",
  ].join(",")
  await run(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      formatSeconds(startT),
      "-i",
      videoPath,
      "-t",
      formatSeconds(duration),
      "-vf",
      filter,
      "-q:v",
      "1",
      path.join(outDir, "frame_%04d.jpg"),
    ],
    { quiet: true }
  )
}
