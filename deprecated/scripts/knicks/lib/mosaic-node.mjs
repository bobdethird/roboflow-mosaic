// Node ports of the canvas-only helpers in lib/mosaic.ts, backed by sharp raw
// pixel buffers instead of a browser canvas. The geometry (contourMosaic) and
// the tile painter (drawPolygonCell) are imported straight from the web engine
// (Node 24 strips types natively), so only the raster sampling lives here. Keep
// the math in lockstep with lib/mosaic.ts so the offline video pipeline matches
// the /knicks-mosaic page.

import sharp from "sharp"

import { SIGNATURE_GRID } from "./signature.mjs"

// Edge-vector field dims, matching the page (components/canvas-hero.tsx).
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

// Reference resized (cover) to w×h as raw RGB bytes.
async function rawCover(referencePath, w, h) {
  const { data, info } = await sharp(referencePath)
    .rotate()
    .resize(w, h, { fit: "cover" })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data, channels: info.channels }
}

function lumOf(data, channels, i) {
  const src = i * channels
  if (channels === 1) return data[src]
  return 0.299 * data[src] + 0.587 * data[src + 1] + 0.114 * data[src + 2]
}

// Port of lib/mosaic.ts `edgeVectorField`: normalized Sobel magnitude plus
// gradient direction over an fw×fh luminance grid of the reference.
export async function edgeVectorField(referencePath, fw, fh) {
  const { data, channels } = await rawCover(referencePath, fw, fh)
  const lum = new Float32Array(fw * fh)
  for (let i = 0; i < fw * fh; i++) lum[i] = lumOf(data, channels, i)
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

// Port of lib/mosaic.ts `referenceWindowSignatures`: per-tile s×s×3 color
// signatures for arbitrary tile centers. The reference is rendered once into a
// buffer scaled so a `size`-px tile window maps to s×s buffer pixels, then each
// tile reads its block straight out of that buffer.
export async function referenceWindowSignatures(
  referencePath,
  centers,
  size,
  width,
  height,
  s = SIGNATURE_GRID
) {
  const n = centers.length / 2
  const scale = s / Math.max(1, size)
  const bw = Math.max(s, Math.round(width * scale))
  const bh = Math.max(s, Math.round(height * scale))
  const { data, channels } = await rawCover(referencePath, bw, bh)
  const clampI = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v)
  const half = s / 2
  const out = new Array(n)
  for (let i = 0; i < n; i++) {
    const bx = centers[i * 2] * scale - half
    const by = centers[i * 2 + 1] * scale - half
    const sx0 = Math.round(bx)
    const sy0 = Math.round(by)
    const sig = new Uint8Array(s * s * 3)
    for (let yy = 0; yy < s; yy++) {
      const py = clampI(sy0 + yy, bh - 1)
      for (let xx = 0; xx < s; xx++) {
        const px = clampI(sx0 + xx, bw - 1)
        const di = (py * bw + px) * channels
        const k = (yy * s + xx) * 3
        if (channels === 1) {
          sig[k] = data[di]
          sig[k + 1] = data[di]
          sig[k + 2] = data[di]
        } else {
          sig[k] = data[di]
          sig[k + 1] = data[di + 1]
          sig[k + 2] = data[di + 2]
        }
      }
    }
    out[i] = sig
  }
  return out
}

// Mean pixel of the reference — the mosaic's grout/background color, mirroring
// lib/mosaic.ts `averageColor`.
export async function averageColor(referencePath) {
  const { channels } = await sharp(referencePath).rotate().stats()
  const [r, g, b] =
    channels.length >= 3
      ? channels.map((c) => Math.round(c.mean))
      : [channels[0].mean, channels[0].mean, channels[0].mean].map(Math.round)
  return `rgb(${r}, ${g}, ${b})`
}

// ---- Coarse matching helpers (mirroring lib/mosaic-worker.ts) ---------------
// Matching runs on a 2×-downsampled signature: identical results to the page's
// worker, ~4× cheaper per comparison than the full 16×16 grid.

export const COARSE_GRID = Math.max(1, SIGNATURE_GRID >> 1)
export const COARSE_LEN = COARSE_GRID * COARSE_GRID * 3
export const COARSE_CHANNELS = COARSE_GRID * COARSE_GRID

export function downsampleSig(s) {
  const out = new Float32Array(COARSE_LEN)
  for (let by = 0; by < COARSE_GRID; by++) {
    for (let bx = 0; bx < COARSE_GRID; bx++) {
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            sum += s[((by * 2 + dy) * SIGNATURE_GRID + (bx * 2 + dx)) * 3 + ch]
          }
        }
        out[(by * COARSE_GRID + bx) * 3 + ch] = sum * 0.25
      }
    }
  }
  return out
}

export function meanRgb(coarse) {
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

// ---- Packed-geometry (de)serialization for the match plan -------------------
// Typed arrays are stored base64 so plan.json stays a single self-contained
// file the later stages can load without sidecar binaries.

export function encodeTypedArray(arr) {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString(
    "base64"
  )
}

function decodeTypedArray(encoded, Ctor) {
  const buf = Buffer.from(encoded, "base64")
  // Copy into a fresh ArrayBuffer so alignment is guaranteed.
  const out = new Uint8Array(buf.byteLength)
  out.set(buf)
  return new Ctor(out.buffer)
}

export function encodeGeometry(geometry) {
  return {
    count: geometry.count,
    tileSize: geometry.tileSize,
    polys: encodeTypedArray(geometry.polys),
    offsets: encodeTypedArray(geometry.offsets),
    angles: encodeTypedArray(geometry.angles),
    centers: encodeTypedArray(geometry.centers),
    bboxes: encodeTypedArray(geometry.bboxes),
  }
}

export function decodeGeometry(encoded) {
  return {
    count: encoded.count,
    tileSize: encoded.tileSize,
    polys: decodeTypedArray(encoded.polys, Float32Array),
    offsets: decodeTypedArray(encoded.offsets, Int32Array),
    angles: decodeTypedArray(encoded.angles, Float32Array),
    centers: decodeTypedArray(encoded.centers, Float32Array),
    bboxes: decodeTypedArray(encoded.bboxes, Float32Array),
  }
}

// Per-cell axis-aligned bounds (x, y, w, h ×count) of the packed polygons —
// used for zoom-window culling and clip sizing.
export function cellBBoxes(polys, offsets, count) {
  const bboxes = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let v = offsets[i]; v < offsets[i + 1]; v++) {
      const x = polys[v * 2]
      const y = polys[v * 2 + 1]
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
    if (!Number.isFinite(minX)) {
      minX = 0
      minY = 0
      maxX = 0
      maxY = 0
    }
    bboxes[i * 4] = minX
    bboxes[i * 4 + 1] = minY
    bboxes[i * 4 + 2] = maxX - minX
    bboxes[i * 4 + 3] = maxY - minY
  }
  return bboxes
}
