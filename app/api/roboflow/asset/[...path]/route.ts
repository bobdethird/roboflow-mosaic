// Serves one ingested dataset's library files off the local cache directory:
// manifest.json, signatures-coarse.bin, reference.jpg, and thumbs/<id>.jpg.
//
// This is the local-disk counterpart to /api/mosaic (which proxies Supabase),
// and it applies the same rules: same-origin only, and no path may escape the
// dataset's own directory.

import { readFile, stat } from "node:fs/promises"
import path from "node:path"

import { isDatasetSlug } from "@/lib/roboflow"
import { datasetFile } from "@/lib/roboflow-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

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
    const info = await stat(file)
    if (!info.isFile()) return new Response("Not found", { status: 404 })
    const bytes = await readFile(file)
    const headers = new Headers({
      "content-type":
        CONTENT_TYPES[path.extname(file).toLowerCase()] ??
        "application/octet-stream",
      "content-length": String(bytes.byteLength),
      // Thumbnails are content-addressed (the filename is a hash of the image
      // bytes), so they can be cached forever. The manifest, signatures, and
      // reference change on every re-ingest, so they must revalidate.
      "cache-control": isThumb
        ? "private, max-age=31536000, immutable"
        : "no-cache",
    })
    return new Response(new Uint8Array(bytes), { headers })
  } catch {
    return new Response("Not found", { status: 404 })
  }
}
