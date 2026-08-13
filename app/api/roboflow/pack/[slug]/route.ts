// Hands the browser one ingested dataset as a single zip: manifest.json,
// signatures-coarse.bin, icon.jpg, and every thumbnail.
//
// This is the only dataset bytes the client ever asks for. It reads tiles out
// of the archive locally (lib/roboflow-pack.ts) instead of requesting them one
// at a time, so there is no per-thumbnail route and no instance that needs the
// dataset on disk to serve one.
//
// On Vercel the archive is already on the Blob CDN, so this redirects there and
// the function moves no bytes at all. Without a Blob store — local development —
// it zips the cache directory on the fly.

import { isDatasetSlug } from "@/lib/roboflow"
import {
  ARCHIVE_FILE,
  blobEnabled,
  blobUrl,
  libraryArchiveStream,
} from "@/lib/roboflow-blob"
import { IS_VERCEL, datasetDir } from "@/lib/roboflow-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// Only the local-development path spends time here; the Blob path is a redirect.
export const maxDuration = 60

function notFound(): Response {
  return new Response("Not found", { status: 404 })
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> }
): Promise<Response> {
  const { slug } = await params
  if (!isDatasetSlug(slug)) return notFound()

  if (IS_VERCEL && !blobEnabled()) {
    return new Response("Dataset storage is not configured.", { status: 503 })
  }

  if (blobEnabled()) {
    const url = await blobUrl(slug, ARCHIVE_FILE)
    if (!url) return notFound()
    // 307 rather than a proxy: the browser pulls from the CDN directly.
    return new Response(null, {
      status: 307,
      headers: { location: url, "cache-control": "no-store" },
    })
  }

  const stream = await libraryArchiveStream(datasetDir(slug)).catch(() => null)
  if (!stream) return notFound()
  return new Response(stream, {
    headers: {
      "content-type": "application/zip",
      "cache-control": "no-store",
    },
  })
}
