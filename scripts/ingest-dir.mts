// Ingest a local folder of images as if it were a Roboflow dataset.
//
//   pnpm ingest:dir <image-dir> <workspace> <project> [version]
//
// Kept as .mts because the package is CommonJS (see package.json) and this
// script runs on top-level await.
//
// Useful for two things: mosaicking a folder you already have on disk, and
// exercising the whole tile pipeline without a Roboflow API key. It writes the
// same cache layout the API route does, so /roboflow can render the result once
// the slug is known.

import { mkdir, readdir, writeFile } from "node:fs/promises"
import path from "node:path"

import { datasetSlug, universeUrl, type IngestStatus } from "@/lib/roboflow"
import { buildLibrary } from "@/lib/roboflow-ingest"
import { datasetDir } from "@/lib/roboflow-store"

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
  ".avif",
])

async function listImages(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true })
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        IMAGE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
    )
    .map((entry) => path.join(entry.parentPath, entry.name))
}

const [imageDir, workspace, project, versionArg] = process.argv.slice(2)
if (!imageDir || !workspace || !project) {
  console.error(
    "usage: pnpm ingest:dir <image-dir> <workspace> <project> [version]"
  )
  process.exit(1)
}

const version = Number(versionArg ?? 1)
const ref = { workspace, project, version }
const slug = datasetSlug(ref)
const outputDir = datasetDir(slug)
await mkdir(outputDir, { recursive: true })

const files = await listImages(path.resolve(imageDir))
if (!files.length) {
  console.error(`No images found under ${imageDir}`)
  process.exit(1)
}
console.log(`${files.length} image(s) → ${outputDir}`)

let lastStep = ""
const result = await buildLibrary(files, outputDir, (step, done, total) => {
  if (step !== lastStep) {
    lastStep = step
    process.stdout.write(`\n${step}`)
  }
  if (total) process.stdout.write(`\r${step} ${done}/${total}   `)
})

const status: IngestStatus = {
  slug,
  state: "ready",
  step: "Ready",
  done: 0,
  total: 0,
  updatedAt: new Date().toISOString(),
  dataset: {
    ...ref,
    slug,
    name: `${workspace}/${project}`,
    imageCount: result.photoCount,
    universeUrl: universeUrl(ref),
    libraryVersion: result.version,
  },
}
await writeFile(path.join(outputDir, "status.json"), JSON.stringify(status, null, 2))

console.log(`\n\nDone: ${result.photoCount} tiles, ${result.skipped} skipped`)
console.log(`slug: ${slug}`)
