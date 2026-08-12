import {
  fetchObject,
  getMosaic,
  ShareStoreNotConfiguredError,
} from "@/lib/mosaic-share-store"

// Public composite image for a shared mosaic. Deliberately NOT same-origin
// guarded (unlike the /api/mosaic photo proxy): link-unfurl crawlers — iMessage,
// Discord, Twitter, Slack — fetch the og:image cross-site with no cookie, so
// this must be openly reachable or every shared link previews broken. The bucket
// stays private; we check the row exists + isn't deleted, then stream the bytes
// with the service key. This route doubles as the on-page <img> source.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const VALID_ID = /^[0-9A-Za-z]{1,32}$/

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  if (!VALID_ID.test(id)) return new Response("Not found", { status: 404 })

  try {
    const row = await getMosaic(id)
    if (!row) return new Response("Not found", { status: 404 })

    const upstream = await fetchObject(
      row.image_path,
      request.headers.get("range")
    )
    if (!upstream.ok) {
      return new Response("Not found", { status: upstream.status })
    }

    const headers = new Headers()
    headers.set("content-type", "image/jpeg")
    for (const h of ["content-length", "content-range", "accept-ranges"]) {
      const v = upstream.headers.get(h)
      if (v) headers.set(h, v)
    }
    // Moderate cache: fast repeat loads + unfurl, but an admin takedown still
    // propagates within minutes (the route then returns 404 at origin).
    headers.set("cache-control", "public, max-age=300, s-maxage=300")

    return new Response(upstream.body, { status: upstream.status, headers })
  } catch (err) {
    if (err instanceof ShareStoreNotConfiguredError) {
      return new Response("Not configured", { status: 503 })
    }
    return new Response("Error", { status: 500 })
  }
}
