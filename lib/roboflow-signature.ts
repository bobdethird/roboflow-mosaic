// Pack a 16×16×3 uint8 colour signature into the mosaic worker's coarse
// uint16 LE format. Shared by the Node ingest (Sharp) and the browser ingest
// (canvas) so both produce bytes the worker can match against.

export const SIG_GRID = 16
export const COARSE_GRID = SIG_GRID >> 1
export const COARSE_VALUES = COARSE_GRID * COARSE_GRID * 3

// Thumbnails are the only image the mosaic ever paints. 192px covers the
// canvas downsample (128) and the hover popup (~224 CSS px).
export const THUMB_LONG_EDGE = 192
export const THUMB_QUALITY = 0.8
export const ICON_MAX_EDGE = 1600
export const ICON_QUALITY = 0.92

// The 16×16 centre-cover crop must be RGB, no alpha. Each stored coarse value
// is the exact 0..1020 sum of a 2×2 block; the worker multiplies by 0.25.
export function packCoarseSignature(sig: Uint8Array): Uint8Array {
  const out = new Uint8Array(COARSE_VALUES * 2)
  const view = new DataView(out.buffer)
  for (let by = 0; by < COARSE_GRID; by++) {
    for (let bx = 0; bx < COARSE_GRID; bx++) {
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            sum += sig[((by * 2 + dy) * SIG_GRID + (bx * 2 + dx)) * 3 + channel]
          }
        }
        view.setUint16(((by * COARSE_GRID + bx) * 3 + channel) * 2, sum, true)
      }
    }
  }
  return out
}
