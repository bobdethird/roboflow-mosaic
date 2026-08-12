// Fetch the project's cover image for a dataset that has already been ingested.
//
// Datasets ingested before cover images were saved have everything else on disk,
// and the cover is one small download — so the page offers it on demand rather
// than making the whole export come down again.

import { isDatasetSlug } from "@/lib/roboflow"
import { RoboflowApiError } from "@/lib/roboflow-api"
import { IngestError, ensureCover } from "@/lib/roboflow-ingest"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request): Promise<Response> {
  let slug: string | undefined
  try {
    ;({ slug } = (await request.json()) as { slug?: string })
  } catch {
    return Response.json({ error: "Expected a JSON body with a `slug`." }, { status: 400 })
  }
  if (!slug || !isDatasetSlug(slug)) {
    return Response.json({ error: "Missing or malformed slug." }, { status: 400 })
  }

  try {
    const hasIcon = await ensureCover(slug)
    return Response.json(
      { slug, hasIcon },
      { headers: { "cache-control": "no-store" } }
    )
  } catch (error) {
    const message =
      error instanceof IngestError || error instanceof RoboflowApiError
        ? error.message
        : error instanceof Error
          ? error.message
          : "Could not fetch the cover image."
    return Response.json({ error: message }, { status: 400 })
  }
}
