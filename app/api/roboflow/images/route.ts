// One page of project images, with thumbnail URLs already derived. The
// browser downloads and seeds those thumbs itself.

import { SEARCH_PAGE_SIZE } from "@/lib/roboflow-limits"
import {
  searchProjectImages,
  thumbUrlFromSource,
  type ProjectImage,
} from "@/lib/roboflow-api"
import { errorMessage, isSameOrigin, json, readApiKeyHeader } from "@/lib/roboflow-http"
import { IS_VERCEL } from "@/lib/roboflow-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 30

const SLUG_RE = /^[a-zA-Z0-9._-]+$/

export type CatalogImage = {
  id: string
  name?: string
  thumbUrl: string | null
}

function catalogImage(image: ProjectImage): CatalogImage {
  const thumb =
    (image.url ? thumbUrlFromSource(image.url) : null) ?? image.url ?? null
  return { id: image.id, name: image.name, thumbUrl: thumb }
}

export async function POST(request: Request): Promise<Response> {
  if (IS_VERCEL && !isSameOrigin(request)) {
    return json({ error: "Cross-origin image requests are not allowed." }, 403)
  }

  let body: {
    workspace?: string
    project?: string
    offset?: number
    limit?: number
  }
  try {
    body = (await request.json()) as typeof body
  } catch {
    return json({ error: "Expected a JSON body with workspace and project." }, 400)
  }

  const workspace = body.workspace?.trim() ?? ""
  const project = body.project?.trim() ?? ""
  if (!SLUG_RE.test(workspace) || !SLUG_RE.test(project)) {
    return json({ error: "Missing or malformed workspace or project." }, 400)
  }

  let apiKey: string | undefined
  try {
    apiKey = readApiKeyHeader(request)
  } catch (error) {
    return json({ error: errorMessage(error) }, 400)
  }

  const offset = Math.max(0, Number(body.offset) || 0)
  const limit = Math.min(
    SEARCH_PAGE_SIZE,
    Math.max(1, Number(body.limit) || SEARCH_PAGE_SIZE)
  )

  try {
    const page = await searchProjectImages(
      { workspace, project, version: null },
      { offset, limit, apiKey }
    )
    return json({
      offset: page.offset,
      total: page.total,
      results: page.results.map(catalogImage),
    })
  } catch (error) {
    return json({ error: errorMessage(error, "Could not list project images.") }, 400)
  }
}
