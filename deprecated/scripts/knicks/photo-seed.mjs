// Photo-mosaic pipeline, stage 2 of 2: index the sampled frames (color
// signature + thumbnail) and publish them as a shared photo-mosaic library to a
// private Supabase Storage bucket. This is the Node equivalent of the browser
// seeder (app/mosaic/seed/page.tsx) and writes the exact same bucket layout:
//
//   manifest.json   { version, photos: [{ id, w, h, fullPath, video }] }   (order == signatures)
//   signatures.bin  concatenated uint8 signatures, SIG_BYTES per photo
//   thumbs/<id>.jpg one downscaled thumbnail per photo
//   originals/<id>  the extracted frame at full resolution (hover/open preview)
//
//   pnpm knicks:photo-frames && pnpm knicks:photo-seed
//
// Needs the project's secret key. It is read from the environment or, if absent
// there, from .env.local (SUPABASE_SECRET_KEY, or legacy SUPABASE_SERVICE_ROLE_KEY).
// Set KNICKS_PHOTO_REUPLOAD=1 to re-upload thumbnails that already exist.
// Set KNICKS_PHOTO_PRUNE=1 to delete orphaned thumbs/originals afterwards —
// objects whose id is not in the manifest published by this run (e.g. tiles
// from a previous extraction resolution). Only use on a full seed run: a run
// over a subset of frames would prune everything outside that subset.

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"

import sharp from "sharp"
import { createClient } from "@supabase/supabase-js"

import { CONFIG } from "./config.mjs"
import { exists } from "./lib/common.mjs"
import { lumStd, signatureFromImage, SIG_BYTES } from "./lib/signature.mjs"

// Keep these in sync with lib/photo-library.ts (the app reads the same layout).
const MANIFEST_PATH = "manifest.json"
const SIGNATURES_PATH = "signatures.bin"
const thumbPath = (id) => `thumbs/${id}.jpg`
const originalPath = (id) => `originals/${id}`

const REUPLOAD = process.env.KNICKS_PHOTO_REUPLOAD === "1"
const PRUNE = process.env.KNICKS_PHOTO_PRUNE === "1"
const INDEX_CONCURRENCY = Math.max(2, os.cpus().length)
const UPLOAD_CONCURRENCY = 12

// Run `fn` over `items` with at most `concurrency` in flight.
async function runPool(items, concurrency, fn) {
  let cursor = 0
  const worker = async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      await fn(items[i], i)
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  )
}

// Load .env.local into process.env (without clobbering already-set vars) so the
// script can be run with a plain `node`/`pnpm` invocation.
async function loadEnvLocal() {
  const envPath = path.join(CONFIG.repoRoot, ".env.local")
  if (!(await exists(envPath))) return
  const text = await fs.readFile(envPath, "utf8")
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const eq = line.indexOf("=")
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    if (!key || key in process.env) continue
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    process.env[key] = value
  }
}

async function listFrameFiles() {
  const root = CONFIG.paths.photoFramesDir
  if (!(await exists(root))) return []
  const dirs = (await fs.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))

  const files = []
  for (const dir of dirs) {
    const dirPath = path.join(root, dir)
    const names = (await fs.readdir(dirPath))
      .filter((name) => name.toLowerCase().endsWith(".jpg"))
      .sort((a, b) => a.localeCompare(b))
    for (const name of names) files.push(path.join(dirPath, name))
  }
  return files
}

// Content-addressed id: first 12 bytes of SHA-256, hex (matches the browser
// seeder, so byte-identical frames de-duplicate naturally).
function hashId(buf) {
  return createHash("sha256").update(buf).digest().subarray(0, 12).toString("hex")
}

async function renderThumb(buf) {
  const { data, info } = await sharp(buf)
    .rotate()
    .resize(CONFIG.photo.thumbMax, CONFIG.photo.thumbMax, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: CONFIG.photo.thumbQuality })
    .toBuffer({ resolveWithObject: true })
  return { blob: data, w: info.width, h: info.height }
}

async function indexFrame(file) {
  const buf = await fs.readFile(file)
  const sig = await signatureFromImage(buf)
  // Skip near-flat frames (outro cards, black/solid slates) before doing the
  // extra thumbnail work — they make poor tiles and shouldn't enter the library.
  if (lumStd(sig) < CONFIG.photo.flatnessMinStd) return { flat: true }
  const id = hashId(buf)
  const thumb = await renderThumb(buf)
  // Source video id (the frame's parent directory) is published in the
  // manifest so the app can report how many distinct clips a mosaic draws from.
  const video = path.basename(path.dirname(file))
  // Keep only the file path for the original (re-read at upload time) so we
  // don't hold thousands of full-res frame buffers in memory.
  return { id, file, sig, thumb: thumb.blob, w: thumb.w, h: thumb.h, video }
}

// Previously published photos, keyed by id, so re-runs can skip uploads that
// already exist (and still backfill originals for entries that predate them).
async function loadExistingPhotos(supabase, bucket) {
  try {
    const { data, error } = await supabase.storage
      .from(bucket)
      .download(MANIFEST_PATH)
    if (error || !data) return new Map()
    const manifest = JSON.parse(await data.text())
    if (!Array.isArray(manifest.photos)) return new Map()
    return new Map(
      manifest.photos
        .filter((photo) => photo?.id)
        .map((photo) => [photo.id, photo])
    )
  } catch {
    return new Map()
  }
}

// Every object name under a prefix (paginated; Supabase list caps at 1000).
async function listAllObjects(supabase, bucket, prefix) {
  const names = []
  const pageSize = 1000
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase.storage
      .from(bucket)
      .list(prefix, { limit: pageSize, offset })
    if (error) throw error
    if (!data?.length) break
    for (const entry of data) if (entry.name) names.push(entry.name)
    if (data.length < pageSize) break
  }
  return names
}

// Delete thumbs/originals whose id is not in `liveIds` (the manifest published
// by this run). Removals are batched; failures are reported, not fatal.
async function pruneOrphans(supabase, bucket, liveIds) {
  const orphans = []
  for (const name of await listAllObjects(supabase, bucket, "thumbs")) {
    if (!liveIds.has(name.replace(/\.jpg$/i, ""))) orphans.push(`thumbs/${name}`)
  }
  for (const name of await listAllObjects(supabase, bucket, "originals")) {
    if (!liveIds.has(name.replace(/\.jpg$/i, ""))) {
      orphans.push(`originals/${name}`)
    }
  }
  if (orphans.length === 0) {
    console.log("  no orphaned objects found")
    return
  }

  let removed = 0
  const BATCH = 200
  for (let i = 0; i < orphans.length; i += BATCH) {
    const batch = orphans.slice(i, i + BATCH)
    const { error } = await supabase.storage.from(bucket).remove(batch)
    if (error) {
      console.warn(`  failed to remove a batch of ${batch.length}: ${error.message}`)
      continue
    }
    removed += batch.length
    process.stdout.write(`\r  removed ${removed}/${orphans.length}`)
  }
  process.stdout.write("\n")
  console.log(`  pruned ${removed} orphaned object(s)`)
}

async function ensureBucket(supabase, bucket) {
  const { data } = await supabase.storage.getBucket(bucket)
  if (data) return
  const { error } = await supabase.storage.createBucket(bucket, {
    public: false,
  })
  if (error && !/already exists/i.test(error.message)) throw error
  console.log(`Created private bucket "${bucket}".`)
}

async function main() {
  await loadEnvLocal()

  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "") ||
    "https://qnpwjltgxgkohtqhprux.supabase.co"
  const key =
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!key) {
    console.error(
      "Missing SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY). Set it in the\n" +
        "environment or .env.local. Find it in Supabase → Project Settings → API Keys."
    )
    process.exit(1)
  }

  const bucket = CONFIG.photo.bucket
  const files = await listFrameFiles()
  if (files.length === 0) {
    console.error(
      `No frames in ${CONFIG.paths.photoFramesDir}. Run pnpm knicks:photo-frames first.`
    )
    process.exit(1)
  }

  const supabase = createClient(supabaseUrl, key, {
    auth: { persistSession: false },
  })
  await ensureBucket(supabase, bucket)
  const existingPhotos = await loadExistingPhotos(supabase, bucket)

  console.log(
    `Indexing ${files.length} frames → bucket "${bucket}" at ${supabaseUrl}` +
      (existingPhotos.size ? ` (${existingPhotos.size} already published)` : "")
  )

  // Phase 1: index every frame locally (signature + thumbnail), in order.
  const indexed = new Array(files.length).fill(null)
  let done = 0
  let failed = 0
  await runPool(files, INDEX_CONCURRENCY, async (file, i) => {
    try {
      indexed[i] = await indexFrame(file)
    } catch {
      failed++
    } finally {
      done++
      if (done % 100 === 0 || done === files.length) {
        process.stdout.write(`\r  indexed ${done}/${files.length}`)
      }
    }
  })
  process.stdout.write("\n")

  // De-duplicate by content id, preserving first-seen order. This order defines
  // both the manifest and the signatures blob, so they must be built together.
  // Near-flat frames flagged during indexing are dropped here.
  const tiles = []
  const seen = new Set()
  let flat = 0
  for (const tile of indexed) {
    if (!tile) continue
    if (tile.flat) {
      flat++
      continue
    }
    if (!seen.has(tile.id)) {
      seen.add(tile.id)
      tiles.push(tile)
    }
  }
  if (flat) console.log(`  dropped ${flat} near-flat frame(s) (outro/black cards)`)
  if (tiles.length === 0) {
    console.error("Every frame failed to index.")
    process.exit(1)
  }

  // Phase 2: upload thumbnails + full-res originals (skip ones already in the
  // bucket unless forced). Originals are also backfilled for tiles published
  // before this script uploaded them, so old manifests gain fullPath on re-run.
  let uploaded = 0
  let skipped = 0
  let uploadFailed = 0
  await runPool(tiles, UPLOAD_CONCURRENCY, async (tile) => {
    const existing = existingPhotos.get(tile.id)

    if (REUPLOAD || !existing) {
      const { error } = await supabase.storage
        .from(bucket)
        .upload(thumbPath(tile.id), tile.thumb, {
          contentType: "image/jpeg",
          upsert: true,
          cacheControl: "31536000",
        })
      if (error) {
        uploadFailed++
        return
      }
      uploaded++
    } else {
      skipped++
    }

    if (REUPLOAD || !existing?.fullPath) {
      const original = await fs.readFile(tile.file)
      const { error } = await supabase.storage
        .from(bucket)
        .upload(originalPath(tile.id), original, {
          contentType: "image/jpeg",
          upsert: true,
          cacheControl: "31536000",
        })
      if (error) {
        uploadFailed++
        return
      }
      tile.fullPath = originalPath(tile.id)
    } else {
      tile.fullPath = existing.fullPath
    }

    if ((uploaded + skipped) % 100 === 0) {
      process.stdout.write(
        `\r  uploaded ${uploaded}, skipped ${skipped}/${tiles.length}`
      )
    }
  })
  process.stdout.write("\n")

  // Phase 3: pack signatures (uint8, manifest order) + build & upload manifest.
  const sigBytes = Buffer.alloc(tiles.length * SIG_BYTES)
  const photos = new Array(tiles.length)
  for (let j = 0; j < tiles.length; j++) {
    const tile = tiles[j]
    photos[j] = {
      id: tile.id,
      w: tile.w,
      h: tile.h,
      fullPath: tile.fullPath,
      video: tile.video,
    }
    sigBytes.set(tile.sig.subarray(0, SIG_BYTES), j * SIG_BYTES)
  }
  const manifest = { version: new Date().toISOString(), photos }

  const manRes = await supabase.storage
    .from(bucket)
    .upload(MANIFEST_PATH, JSON.stringify(manifest), {
      contentType: "application/json",
      upsert: true,
      cacheControl: "60",
    })
  if (manRes.error) throw manRes.error

  const sigRes = await supabase.storage
    .from(bucket)
    .upload(SIGNATURES_PATH, sigBytes, {
      contentType: "application/octet-stream",
      upsert: true,
      cacheControl: "300",
    })
  if (sigRes.error) throw sigRes.error

  // Phase 4 (opt-in): now that the manifest only references this run's tiles,
  // anything else under thumbs/ or originals/ is unreachable — delete it.
  if (PRUNE) {
    console.log("Pruning orphaned objects…")
    await pruneOrphans(supabase, bucket, seen)
  }

  console.log(
    `Published ${tiles.length} tiles ` +
      `(uploaded ${uploaded}, skipped ${skipped}` +
      `${uploadFailed ? `, ${uploadFailed} upload failures` : ""}` +
      `${failed ? `, ${failed} index failures` : ""}). Open /knicks-mosaic`
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
