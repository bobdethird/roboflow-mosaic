import {
  fetchObject,
  getMosaic,
  ShareStoreNotConfiguredError,
} from "@/lib/mosaic-share-store"

// Public per-tile zoom geometry for a shared mosaic. Fetched lazily by the zoom
// viewer the first time someone zooms in (never on first paint). Carries no
// secret — it's public mosaic data — so it's served the same dedicated way as the
// composite image + hit-map. Returns 404 for mosaics published before geometry
// existed (geometry_path is null); the viewer then zooms the base image only.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const VALID_ID = /^[0-9A-Za-z]{1,32}$/

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  if (!VALID_ID.test(id)) return new Response("Not found", { status: 404 })

  try {
    const row = await getMosaic(id)
    if (!row || !row.geometry_path) {
      return new Response("Not found", { status: 404 })
    }

    const upstream = await fetchObject(row.geometry_path)
    if (!upstream.ok) {
      return new Response("Not found", { status: upstream.status })
    }

    const headers = new Headers()
    headers.set("content-type", "application/json")
    headers.set("cache-control", "public, max-age=300, s-maxage=300")
    return new Response(upstream.body, { status: 200, headers })
  } catch (err) {
    if (err instanceof ShareStoreNotConfiguredError) {
      return new Response("Not configured", { status: 503 })
    }
    return new Response("Error", { status: 500 })
  }
}
