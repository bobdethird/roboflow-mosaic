// Stream one Roboflow thumbnail through this origin so a missing CDN CORS
// header cannot stop the browser ingest. The URL must already be on an
// allowlisted host — this is not a general-purpose proxy.

import { fetchImageDetails, thumbUrlFromSource } from "@/lib/roboflow-api"
import { errorMessage, isSameOrigin, json } from "@/lib/roboflow-http"
import { isAllowedImageUrl } from "@/lib/roboflow-proxy"
import { IS_VERCEL } from "@/lib/roboflow-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 15

const SLUG_RE = /^[a-zA-Z0-9._-]+$/
const REQUEST_TIMEOUT_MS = 20_000

async function resolveRequestedUrl(request: Request): Promise<string | null> {
  const params = new URL(request.url).searchParams
  const direct = params.get("url")?.trim()
  if (direct) return direct

  const workspace = params.get("workspace")?.trim() ?? ""
  const project = params.get("project")?.trim() ?? ""
  const id = params.get("id")?.trim() ?? ""
  if (!SLUG_RE.test(workspace) || !SLUG_RE.test(project) || !id) return null

  const details = await fetchImageDetails(
    { workspace, project, version: null },
    id
  )
  return details.urls.thumb ?? details.urls.original ?? null
}

export async function GET(request: Request): Promise<Response> {
  if (IS_VERCEL && !isSameOrigin(request)) {
    return json({ error: "Cross-origin thumbnail requests are not allowed." }, 403)
  }

  let target: string | null
  try {
    target = await resolveRequestedUrl(request)
  } catch (error) {
    return json({ error: errorMessage(error, "Could not resolve that image.") }, 400)
  }
  if (!target || !isAllowedImageUrl(target)) {
    return json({ error: "That image URL is not allowed." }, 400)
  }

  // Search sometimes hands back an original; prefer the thumb sibling.
  const preferred = thumbUrlFromSource(target) ?? target
  const url = isAllowedImageUrl(preferred) ? preferred : target

  try {
    const upstream = await fetch(url, {
      cache: "no-store",
      redirect: "follow",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!upstream.ok) {
      return json(
        { error: `Downloading an image failed (${upstream.status}).` },
        upstream.status === 404 ? 404 : 502
      )
    }
    const contentType = upstream.headers.get("content-type") ?? "image/jpeg"
    return new Response(upstream.body, {
      headers: {
        "content-type": contentType.startsWith("image/")
          ? contentType
          : "image/jpeg",
        "cache-control": "public, max-age=86400",
      },
    })
  } catch (error) {
    return json({ error: errorMessage(error, "The image download failed.") }, 502)
  }
}
