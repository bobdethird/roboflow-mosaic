// Browser decode of one source image into the mosaic tile pair: a coarse
// colour signature and a 192px JPEG. Runs in a worker (OffscreenCanvas) or
// on the main thread as a fallback. Must stay free of `document` / `window`.

import {
  ICON_MAX_EDGE,
  ICON_QUALITY,
  SIG_GRID,
  THUMB_LONG_EDGE,
  THUMB_QUALITY,
  packCoarseSignature,
} from "./roboflow-signature"

function requireContext(canvas: OffscreenCanvas): OffscreenCanvasRenderingContext2D {
  const ctx = canvas.getContext("2d", { willReadFrequently: true })
  if (!ctx) throw new Error("2D canvas context unavailable")
  return ctx
}

function rgbFromImageData(data: Uint8ClampedArray): Uint8Array {
  const rgb = new Uint8Array((data.length / 4) * 3)
  for (let i = 0, j = 0; i < data.length; i += 4, j += 3) {
    rgb[j] = data[i]
    rgb[j + 1] = data[i + 1]
    rgb[j + 2] = data[i + 2]
  }
  return rgb
}

function coverDraw(
  ctx: OffscreenCanvasRenderingContext2D,
  bitmap: ImageBitmap,
  dw: number,
  dh: number
): void {
  const iw = bitmap.width
  const ih = bitmap.height
  if (!iw || !ih) return
  const imgRatio = iw / ih
  const dstRatio = dw / dh
  let sx = 0
  let sy = 0
  let sw = iw
  let sh = ih
  if (imgRatio > dstRatio) {
    sw = ih * dstRatio
    sx = (iw - sw) / 2
  } else {
    sh = iw / dstRatio
    sy = (ih - sh) / 2
  }
  ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, dw, dh)
}

export type ClientDecode = {
  width: number
  height: number
  signature: Uint8Array
  thumbnail: ArrayBuffer
}

export async function decodeOutputs(bytes: ArrayBuffer): Promise<ClientDecode> {
  const bitmap = await createImageBitmap(new Blob([bytes]))
  try {
    const width = bitmap.width
    const height = bitmap.height
    if (!width || !height) {
      throw new Error("Image has no dimensions.")
    }

    const sigCanvas = new OffscreenCanvas(SIG_GRID, SIG_GRID)
    const sigCtx = requireContext(sigCanvas)
    sigCtx.fillStyle = "#ffffff"
    sigCtx.fillRect(0, 0, SIG_GRID, SIG_GRID)
    coverDraw(sigCtx, bitmap, SIG_GRID, SIG_GRID)
    const signature = packCoarseSignature(
      rgbFromImageData(sigCtx.getImageData(0, 0, SIG_GRID, SIG_GRID).data)
    )

    const scale = Math.min(1, THUMB_LONG_EDGE / Math.max(width, height))
    const tw = Math.max(1, Math.round(width * scale))
    const th = Math.max(1, Math.round(height * scale))
    const thumbCanvas = new OffscreenCanvas(tw, th)
    const thumbCtx = requireContext(thumbCanvas)
    thumbCtx.fillStyle = "#ffffff"
    thumbCtx.fillRect(0, 0, tw, th)
    thumbCtx.drawImage(bitmap, 0, 0, tw, th)
    const thumbBlob = await thumbCanvas.convertToBlob({
      type: "image/jpeg",
      quality: THUMB_QUALITY,
    })

    return {
      width,
      height,
      signature,
      thumbnail: await thumbBlob.arrayBuffer(),
    }
  } finally {
    bitmap.close()
  }
}

export async function decodeIcon(bytes: ArrayBuffer): Promise<Blob> {
  const bitmap = await createImageBitmap(new Blob([bytes]))
  try {
    const scale = Math.min(
      1,
      ICON_MAX_EDGE / Math.max(bitmap.width, bitmap.height)
    )
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = new OffscreenCanvas(width, height)
    const ctx = requireContext(canvas)
    ctx.fillStyle = "#ffffff"
    ctx.fillRect(0, 0, width, height)
    ctx.drawImage(bitmap, 0, 0, width, height)
    return canvas.convertToBlob({ type: "image/jpeg", quality: ICON_QUALITY })
  } finally {
    bitmap.close()
  }
}
