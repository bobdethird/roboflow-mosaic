import sharp from "sharp"

export const SIGNATURE_GRID = 16
export const SIGNATURE_CHANNELS = 3
export const SIG_BYTES = SIGNATURE_GRID * SIGNATURE_GRID * SIGNATURE_CHANNELS

export async function signatureFromImage(imagePath, grid = SIGNATURE_GRID) {
  const { data, info } = await sharp(imagePath)
    .rotate()
    .resize(grid, grid, { fit: "cover" })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true })

  const sig = new Uint8Array(grid * grid * SIGNATURE_CHANNELS)
  for (let i = 0; i < grid * grid; i++) {
    const src = i * info.channels
    const dst = i * SIGNATURE_CHANNELS
    if (info.channels === 1) {
      sig[dst] = data[src]
      sig[dst + 1] = data[src]
      sig[dst + 2] = data[src]
    } else {
      sig[dst] = data[src]
      sig[dst + 1] = data[src + 1]
      sig[dst + 2] = data[src + 2]
    }
  }
  return sig
}

// `fit: "fill"` so the whole reference maps onto the grid with no hidden crop.
// The grid spans a rect that matches the reference's aspect (see
// mosaicRectForReference), so each cell's squashed 16×16 sample still
// corresponds to the region it occupies on screen.
export async function referenceCellSignatures(referencePath, cols, rows) {
  const width = cols * SIGNATURE_GRID
  const height = rows * SIGNATURE_GRID
  const { data, info } = await sharp(referencePath)
    .rotate()
    .resize(width, height, { fit: "fill" })
    .removeAlpha()
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true })

  const signatures = []
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const sig = new Uint8Array(SIG_BYTES)
      let dst = 0
      for (let y = 0; y < SIGNATURE_GRID; y++) {
        const srcY = row * SIGNATURE_GRID + y
        for (let x = 0; x < SIGNATURE_GRID; x++) {
          const srcX = col * SIGNATURE_GRID + x
          const src = (srcY * width + srcX) * info.channels
          if (info.channels === 1) {
            sig[dst++] = data[src]
            sig[dst++] = data[src]
            sig[dst++] = data[src]
          } else {
            sig[dst++] = data[src]
            sig[dst++] = data[src + 1]
            sig[dst++] = data[src + 2]
          }
        }
      }
      signatures.push(sig)
    }
  }
  return signatures
}

export function encodeSignature(sig) {
  return Buffer.from(sig).toString("base64")
}

export function decodeSignature(encoded) {
  return new Uint8Array(Buffer.from(encoded, "base64"))
}

// Luminance std-dev over the 16×16 signature — a cheap "how flat is this frame"
// measure. Outro cards / solid slates / black transitions are near-flat (low),
// while real gameplay/crowd frames (even dark ones) are well above the cutoff.
export function lumStd(sig) {
  const n = sig.length / 3
  const lum = new Float64Array(n)
  let mean = 0
  for (let i = 0; i < n; i++) {
    lum[i] =
      0.299 * sig[i * 3] + 0.587 * sig[i * 3 + 1] + 0.114 * sig[i * 3 + 2]
    mean += lum[i]
  }
  mean /= n
  let v = 0
  for (const x of lum) v += (x - mean) ** 2
  return Math.sqrt(v / n)
}

export function mse(a, b) {
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    sum += d * d
  }
  return sum / a.length
}
