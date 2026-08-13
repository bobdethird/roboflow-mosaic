// Builds the tile library in the browser from a Roboflow export zip.
//
// The server only resolves the dataset and hands back an export link (proxied
// same-origin so CORS does not matter). Decode, signatures and thumbnails run
// on the user's machine — the thing that was slow on a 1–2 vCPU function.

import { MAX_INDEXED_IMAGES, TILE_BUDGET } from "./roboflow-limits"
import { type RoboflowDataset } from "./roboflow"
import {
  registerPack,
  type PackManifest,
  type RoboflowPack,
} from "./roboflow-pack"
import { planTileSample } from "./roboflow-sample"
import { readZipEntries, readZipIndex } from "./roboflow-zip-web"

const SIG_GRID = 16
const COARSE_GRID = SIG_GRID >> 1
const COARSE_VALUES = COARSE_GRID * COARSE_GRID * 3
const THUMB_LONG_EDGE = 192
const THUMB_QUALITY = 0.8
const ICON_MAX_EDGE = 1600
const READ_CONCURRENCY = 8

export type ClientProgress = {
  step: string
  done: number
  total: number
}

export type ClientIngestResult = {
  dataset: RoboflowDataset
  pack: RoboflowPack
}

function asBlobPart(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

function hexSha1Prefix(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes)
  let hex = ""
  for (let i = 0; i < 8; i++) {
    hex += view[i]!.toString(16).padStart(2, "0")
  }
  return hex
}

function coarseSignature(sig: Uint8Array): Uint8Array {
  const out = new Uint8Array(COARSE_VALUES * 2)
  const view = new DataView(out.buffer)
  for (let by = 0; by < COARSE_GRID; by++) {
    for (let bx = 0; bx < COARSE_GRID; bx++) {
      for (let channel = 0; channel < 3; channel++) {
        let sum = 0
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            sum += sig[((by * 2 + dy) * SIG_GRID + (bx * 2 + dx)) * 3 + channel]!
          }
        }
        view.setUint16(((by * COARSE_GRID + bx) * 3 + channel) * 2, sum, true)
      }
    }
  }
  return out
}

function coverDraw(
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D,
  bitmap: ImageBitmap,
  dw: number,
  dh: number
): void {
  const scale = Math.max(dw / bitmap.width, dh / bitmap.height)
  const w = bitmap.width * scale
  const h = bitmap.height * scale
  ctx.fillStyle = "#ffffff"
  ctx.fillRect(0, 0, dw, dh)
  ctx.drawImage(bitmap, (dw - w) / 2, (dh - h) / 2, w, h)
}

function canvas2d(
  width: number,
  height: number
): {
  canvas: OffscreenCanvas | HTMLCanvasElement
  ctx: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D
} {
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext("2d", { alpha: false })
    if (!ctx) throw new Error("Could not create a canvas context.")
    return { canvas, ctx }
  }
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext("2d", { alpha: false })
  if (!ctx) throw new Error("Could not create a canvas context.")
  return { canvas, ctx }
}

async function canvasJpeg(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  quality: number
): Promise<Blob> {
  if ("convertToBlob" in canvas) {
    return canvas.convertToBlob({ type: "image/jpeg", quality })
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("JPEG encode failed."))),
      "image/jpeg",
      quality
    )
  })
}

async function decodeOutputs(bytes: Uint8Array): Promise<{
  width: number
  height: number
  signature: Uint8Array
  thumbnail: Blob
}> {
  const blob = new Blob([asBlobPart(bytes)])
  const bitmap = await createImageBitmap(blob)
  try {
    const sigCanvas = canvas2d(SIG_GRID, SIG_GRID)
    coverDraw(sigCanvas.ctx, bitmap, SIG_GRID, SIG_GRID)
    const pixels = sigCanvas.ctx.getImageData(0, 0, SIG_GRID, SIG_GRID).data
    const rgb = new Uint8Array(SIG_GRID * SIG_GRID * 3)
    for (let i = 0, o = 0; i < pixels.length; i += 4, o += 3) {
      rgb[o] = pixels[i]!
      rgb[o + 1] = pixels[i + 1]!
      rgb[o + 2] = pixels[i + 2]!
    }

    const scale = Math.min(1, THUMB_LONG_EDGE / Math.max(bitmap.width, bitmap.height))
    const tw = Math.max(1, Math.round(bitmap.width * scale))
    const th = Math.max(1, Math.round(bitmap.height * scale))
    const thumb = canvas2d(tw, th)
    thumb.ctx.fillStyle = "#ffffff"
    thumb.ctx.fillRect(0, 0, tw, th)
    thumb.ctx.drawImage(bitmap, 0, 0, tw, th)

    return {
      width: bitmap.width,
      height: bitmap.height,
      signature: coarseSignature(rgb),
      thumbnail: await canvasJpeg(thumb.canvas, THUMB_QUALITY),
    }
  } finally {
    bitmap.close()
  }
}

async function downloadIcon(
  url: string,
  signal?: AbortSignal
): Promise<Blob | null> {
  try {
    const response = await fetch(url, { signal, cache: "no-store" })
    if (!response.ok) return null
    const blob = await response.blob()
    const bitmap = await createImageBitmap(blob)
    try {
      const scale = Math.min(
        1,
        ICON_MAX_EDGE / Math.max(bitmap.width, bitmap.height)
      )
      const w = Math.max(1, Math.round(bitmap.width * scale))
      const h = Math.max(1, Math.round(bitmap.height * scale))
      const { canvas, ctx } = canvas2d(w, h)
      ctx.fillStyle = "#ffffff"
      ctx.fillRect(0, 0, w, h)
      ctx.drawImage(bitmap, 0, 0, w, h)
      return await canvasJpeg(canvas, 0.92)
    } finally {
      bitmap.close()
    }
  } catch {
    return null
  }
}

function toDataset(
  base: RoboflowDataset,
  photos: PackManifest["photos"],
  sourceImages: number,
  sampled: boolean,
  hasIcon: boolean,
  version: string
): RoboflowDataset {
  return {
    ...base,
    imageCount: photos.length,
    sourceImages: sampled ? Math.max(sourceImages, base.sourceImages ?? 0) : undefined,
    hasIcon,
    libraryVersion: version,
  }
}

export async function ingestExportInBrowser(
  prepared: {
    dataset: RoboflowDataset
    exportUrl: string
    iconUrl?: string
  },
  onProgress: (progress: ClientProgress) => void,
  signal?: AbortSignal
): Promise<ClientIngestResult> {
  onProgress({ step: "Reading export index", done: 0, total: 0 })
  const index = await readZipIndex(prepared.exportUrl, {
    maxEntries: MAX_INDEXED_IMAGES,
    signal,
  })
  if (!index) {
    throw new Error("Could not read the dataset export.")
  }
  if (!index.entries.length) {
    throw new Error("The dataset export contained no images.")
  }

  const plan = planTileSample(index, { budget: TILE_BUDGET })
  type Photo = PackManifest["photos"][number]
  const kept = new Map<
    string,
    { photo: Photo; signature: Uint8Array; thumbnail: Blob }
  >()
  const seen = new Set<string>()
  let processed = 0
  let skipped = 0

  const tick = () => {
    processed += 1
    onProgress({ step: "Building tiles", done: processed, total: plan.length })
  }

  onProgress({ step: "Building tiles", done: 0, total: plan.length })
  await readZipEntries(
    prepared.exportUrl,
    plan,
    async (entry, bytes) => {
      signal?.throwIfAborted()
      try {
        const digest = await crypto.subtle.digest("SHA-1", asBlobPart(bytes))
        const id = hexSha1Prefix(digest)
        if (seen.has(id)) return
        seen.add(id)
        const decoded = await decodeOutputs(bytes)
        kept.set(entry.name, {
          photo: {
            id,
            w: decoded.width,
            h: decoded.height,
            file: entry.name.split("/").pop() ?? entry.name,
          },
          signature: decoded.signature,
          thumbnail: decoded.thumbnail,
        })
      } catch {
        skipped += 1
      } finally {
        tick()
      }
    },
    {
      concurrency: READ_CONCURRENCY,
      signal,
      onEntryError: () => {
        skipped += 1
        tick()
      },
    }
  )

  if (!kept.size) {
    throw new Error(
      skipped
        ? "None of the dataset's images could be read."
        : "The dataset export contained no images."
    )
  }

  const version = new Date().toISOString()
  const photos: Photo[] = []
  const signatures = new Uint8Array(kept.size * COARSE_VALUES * 2)
  let offset = 0
  const thumbs = new Map<string, Blob>()
  for (const name of [...kept.keys()].sort()) {
    const entry = kept.get(name)
    if (!entry) continue
    photos.push(entry.photo)
    signatures.set(entry.signature, offset)
    offset += entry.signature.length
    thumbs.set(entry.photo.id, entry.thumbnail)
  }

  let iconBlob: Blob | null = null
  if (prepared.iconUrl) {
    onProgress({ step: "Fetching project cover image", done: 0, total: 0 })
    iconBlob = await downloadIcon(prepared.iconUrl, signal)
  }

  const objectUrls: string[] = []
  const thumbUrls = new Map<string, string>()
  const urlFor = (id: string): string | null => {
    const existing = thumbUrls.get(id)
    if (existing) return existing
    const blob = thumbs.get(id)
    if (!blob) return null
    const url = URL.createObjectURL(blob)
    thumbUrls.set(id, url)
    objectUrls.push(url)
    return url
  }

  let iconUrl: string | null = null
  if (iconBlob) {
    iconUrl = URL.createObjectURL(iconBlob)
    objectUrls.push(iconUrl)
  }

  const manifest: PackManifest = { version, photos }
  const pack: RoboflowPack = {
    slug: prepared.dataset.slug,
    version,
    manifest,
    signatures,
    iconUrl,
    thumbUrl: urlFor,
    release: () => {
      for (const url of objectUrls) URL.revokeObjectURL(url)
      objectUrls.length = 0
      thumbUrls.clear()
    },
  }
  registerPack(pack)

  const sampled = plan.length < index.imageCount
  return {
    pack,
    dataset: toDataset(
      prepared.dataset,
      photos,
      index.imageCount,
      sampled,
      Boolean(iconUrl),
      version
    ),
  }
}
