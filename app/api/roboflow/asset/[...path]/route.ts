// Serves one ingested dataset's library files: manifest.json,
// signatures-coarse.bin, reference.jpg, and thumbs/<id>.jpg. Same-origin only,
// and no path may escape the dataset's own directory.
//
// The local cache is tried first. On a serverless host that cache is empty
// unless this instance ran the ingest, so a miss hydrates from the published
// archive and then serves from disk the same way.

import { readFile, stat } from "node:fs/promises"
import path from "node:path"

import { isDatasetSlug } from "@/lib/roboflow"
import { blobEnabled, ensureLocalDataset } from "@/lib/roboflow-blob"
import { datasetFile } from "@/lib/roboflow-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// Hydrating a published library from Blob can take longer than the default
// serverless budget, especially for a dataset with hundreds of thumbnails.
export const maxDuration = 60

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".bin": "application/octet-stream",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
}

// Only these live under a dataset directory and are safe to hand out; `source/`
// (the raw export) and `status.json` are deliberately not served.
const ALLOWED = new Set([
  "manifest.json",
  "signatures-coarse.bin",
  "reference.jpg",
  "icon.jpg",
])

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

async function fileResponse(file: string, immutable: boolean): Promise<Response> {
  const info = await stat(file)
  if (!info.isFile()) throw new Error("Not a file")
  const bytes = await readFile(file)
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type":
        CONTENT_TYPES[path.extname(file).toLowerCase()] ??
        "application/octet-stream",
      "content-length": String(bytes.byteLength),
      // Thumbnails are content-addressed (the filename is a hash of the image
      // bytes), so they can be cached forever. The manifest, signatures, and
      // reference change on every re-ingest, so they must revalidate.
      "cache-control": immutable
        ? "private, max-age=31536000, immutable"
        : "no-cache",
    },
  })
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path?: string[] }> }
): Promise<Response> {
  if (!isSameOriginRequest(request)) {
    return new Response("Forbidden", { status: 403 })
  }

  const { path: segments } = await params
  if (!segments?.length || segments.some((s) => !s || s === "..")) {
    return new Response("Not found", { status: 404 })
  }

  const [slug, ...rest] = segments
  if (!isDatasetSlug(slug) || rest.length === 0) {
    return new Response("Not found", { status: 404 })
  }

  const relative = rest.join("/")
  const isThumb = rest.length === 2 && rest[0] === "thumbs"
  if (!isThumb && !ALLOWED.has(relative)) {
    return new Response("Not found", { status: 404 })
  }

  const file = datasetFile(slug, relative)
  if (!file) return new Response("Not found", { status: 404 })

  try {
    return await fileResponse(file, isThumb)
  } catch {
    if (!blobEnabled()) return new Response("Not found", { status: 404 })
    try {
      await ensureLocalDataset(slug)
      return await fileResponse(file, isThumb)
    } catch {
      return new Response("Not found", { status: 404 })
    }
  }
}
