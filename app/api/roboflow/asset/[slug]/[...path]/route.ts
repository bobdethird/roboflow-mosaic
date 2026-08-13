// Serves one file of an ingested dataset: manifest.json, signatures-coarse.bin,
// icon.jpg, or thumbs/<id>.jpg.
//
// The browser used to download the whole library as a single zip before it
// could draw anything. A mosaic only paints a fraction of a large dataset's
// images, so tiles are fetched through here instead, one at a time and only
// when a tile is actually placed.
//
// Two backings, in order: the local cache directory (the normal case in
// development, and on the instance that ran the ingest), then a byte-range read
// into the archive published to Blob, which is the only copy a serverless
// instance can reach.
//
// Thumbnail filenames are a hash of the image bytes, so those responses are
// immutable and the CDN can keep them; the function is not invoked again for a
// tile that has already been served.

import { readFile, stat } from "node:fs/promises"
import path from "node:path"

import {
  COARSE_SIGNATURES_FILE,
  ICON_FILE,
  MANIFEST_FILE,
  isDatasetSlug,
} from "@/lib/roboflow"
import { readArchiveFile } from "@/lib/roboflow-archive"
import { blobEnabled } from "@/lib/roboflow-blob"
import { datasetFile } from "@/lib/roboflow-store"

export const runtime = "nodejs"

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".bin": "application/octet-stream",
  ".jpg": "image/jpeg",
}

const FIXED_FILES = new Set([MANIFEST_FILE, COARSE_SIGNATURES_FILE, ICON_FILE])
// Thumbnails are named for the hash of their bytes; nothing else is servable
// out of a dataset directory (`source/` and `status.json` are deliberately not).
const THUMB_RE = /^thumbs\/[a-f0-9]{16}\.jpg$/i

function notFound(): Response {
  return new Response("Not found", { status: 404 })
}

function isSameOriginRequest(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site")
  if (fetchSite) return fetchSite !== "cross-site"
  const referer = request.headers.get("referer")
  if (!referer) return true
  try {
    return new URL(referer).host === request.headers.get("host")
  } catch {
    return false
  }
}

async function localBytes(
  slug: string,
  relativePath: string
): Promise<Uint8Array | null> {
  const file = datasetFile(slug, relativePath)
  if (!file) return null
  try {
    const info = await stat(file)
    if (!info.isFile()) return null
    return new Uint8Array(await readFile(file))
  } catch {
    return null
  }
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string; path?: string[] }> }
): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return new Response("Forbidden", { status: 403 })
  }

  const { slug, path: segments } = await params
  if (!isDatasetSlug(slug) || !segments?.length) return notFound()

  const relativePath = segments.join("/")
  const isThumb = THUMB_RE.test(relativePath)
  if (!isThumb && !FIXED_FILES.has(relativePath)) return notFound()

  const bytes =
    (await localBytes(slug, relativePath)) ??
    (blobEnabled() ? await readArchiveFile(slug, relativePath) : null)
  if (!bytes) return notFound()

  // A thumbnail's name already identifies its bytes. The manifest, signatures,
  // and cover change on re-ingest, so they are only cacheable when the caller
  // pinned a library version on the URL.
  const versioned = isThumb || new URL(request.url).searchParams.has("v")

  return new Response(bytes as BodyInit, {
    headers: {
      "content-type":
        CONTENT_TYPES[path.extname(relativePath).toLowerCase()] ??
        "application/octet-stream",
      "content-length": String(bytes.byteLength),
      "cache-control": versioned
        ? "public, max-age=31536000, immutable"
        : "no-cache",
    },
  })
}
