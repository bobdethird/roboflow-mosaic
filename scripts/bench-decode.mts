// Throwaway benchmark: per-image cost of the ingest's decodeOutputs, split by
// which outputs are requested, so the median contribution can be priced against
// the signature + thumbnail work.

import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import sharp from "sharp"

const SIG_GRID = 16
const THUMB_LONG_EDGE = 384
const THUMB_QUALITY = 82
const FRAME = { width: 512, height: 512 }

async function rawRgb(
  pipeline: sharp.Sharp,
  width: number,
  height: number,
  fit: "cover" | "fill"
): Promise<Buffer> {
  const { data } = await pipeline
    .resize(width, height, {
      fit,
      ...(fit === "cover" ? { position: "centre" as const } : {}),
    })
    .flatten({ background: "#ffffff" })
    .toColourspace("srgb")
    .raw()
    .toBuffer({ resolveWithObject: true })
  return data
}

// A few distinct 640x640 JPEGs so nothing gets cached at the codec level.
async function makeImages(n: number): Promise<Buffer[]> {
  const out: Buffer[] = []
  for (let i = 0; i < n; i++) {
    const noise = Buffer.allocUnsafe(640 * 640 * 3)
    for (let p = 0; p < noise.length; p++) noise[p] = (Math.random() * 256) | 0
    out.push(
      await sharp(noise, { raw: { width: 640, height: 640, channels: 3 } })
        .jpeg({ quality: 85 })
        .toBuffer()
    )
  }
  return out
}

const N = 60
const dir = await mkdtemp(path.join(tmpdir(), "bench-decode-"))
console.log(`generating ${N} 640x640 JPEGs...`)
const images = await makeImages(N)
console.log(`avg jpeg size: ${(images.reduce((a, b) => a + b.length, 0) / N / 1024).toFixed(0)} KB\n`)

async function time(label: string, fn: (bytes: Buffer, i: number) => Promise<unknown>) {
  const t = performance.now()
  for (let i = 0; i < N; i++) await fn(images[i], i)
  const per = (performance.now() - t) / N
  console.log(`${label.padEnd(34)} ${per.toFixed(1).padStart(6)} ms/image`)
  return per
}

const metadataOnly = await time("metadata only", async (b) =>
  sharp(b, { failOn: "none" }).metadata()
)
const sig = await time("+ 16x16 signature", async (b) =>
  rawRgb(sharp(b, { failOn: "none" }).clone(), SIG_GRID, SIG_GRID, "cover")
)
const thumb = await time("+ 384px thumbnail encode", async (b, i) =>
  sharp(b, { failOn: "none" })
    .clone()
    .resize(THUMB_LONG_EDGE, THUMB_LONG_EDGE, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: THUMB_QUALITY })
    .toFile(path.join(dir, `${i}.jpg`))
)
const medianResize = await time("+ 512x512 fill raw (median feed)", async (b) =>
  rawRgb(sharp(b, { failOn: "none" }).clone(), FRAME.width, FRAME.height, "fill")
)

console.log(
  `\nsignature+thumb per image:      ${(sig + thumb - metadataOnly).toFixed(1)} ms`
)
console.log(`median resize per image:        ${(medianResize - metadataOnly).toFixed(1)} ms`)
console.log(`median histogram add per image: 12.1 ms   (from bench-median)`)

await rm(dir, { recursive: true, force: true })
