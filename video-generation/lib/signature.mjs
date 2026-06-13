export const SIGNATURE_GRID = 16
export const SIGNATURE_CHANNELS = 3
export const SIG_BYTES = SIGNATURE_GRID * SIGNATURE_GRID * SIGNATURE_CHANNELS

export const COARSE_GRID = SIGNATURE_GRID >> 1
export const COARSE_CHANNELS = COARSE_GRID * COARSE_GRID
export const COARSE_LEN = COARSE_CHANNELS * SIGNATURE_CHANNELS

export function downsampleSig(sig) {
  const out = new Float32Array(COARSE_LEN)
  for (let by = 0; by < COARSE_GRID; by++) {
    for (let bx = 0; bx < COARSE_GRID; bx++) {
      for (let ch = 0; ch < 3; ch++) {
        let sum = 0
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const src =
              ((by * 2 + dy) * SIGNATURE_GRID + (bx * 2 + dx)) * 3 + ch
            sum += sig[src]
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
  let variance = 0
  for (const value of lum) variance += (value - mean) ** 2
  return Math.sqrt(variance / n)
}
