import { SUPABASE_URL, isGatedBucket, isMosaicBucket } from "@/lib/photo-library"
import { hasValidUnlock } from "@/lib/mosaic-auth"

export const runtime = "nodejs"
// This handler authorizes per-request (cookie + same-origin), so it must never be
// statically cached or collapsed into a shared route cache.
export const dynamic = "force-dynamic"

const PASSTHROUGH_HEADERS = [
  "accept-ranges",
  "cache-control",
  "content-length",
  "content-range",
  "content-type",
  "etag",
  "last-modified",
]

function supabaseAdminKey(): string | undefined {
  return (
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  )
}

// The Storage bucket is private, so it's only reachable through this proxy. This
// keeps the proxy itself from being used to hotlink the photos from another
// site: browsers send `Sec-Fetch-Site` on every request, so we allow our own
// same-origin/same-site loads plus direct, user-initiated navigations (e.g.
// opening a tile in a new tab) and reject only clear cross-site requests. The
// Referer host is a fallback for the rare client that omits `Sec-Fetch-Site`.
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

function encodeStoragePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ path?: string[] }> }
) {
  if (!isSameOriginRequest(request)) {
    return new Response("Forbidden", { status: 403 })
  }

  const key = supabaseAdminKey()
  if (!key) {
    return new Response("SUPABASE_SECRET_KEY is not configured.", {
      status: 500,
    })
  }

  const { path } = await params
  if (!path?.length || path.some((segment) => !segment || segment === "..")) {
    return new Response("Not found", { status: 404 })
  }

  // First segment selects the collection's bucket; the rest is the object path.
  // Validating against the known buckets keeps the proxy from reading anything
  // else in the project.
  const [bucket, ...objectPath] = path
  if (!isMosaicBucket(bucket) || objectPath.length === 0) {
    return new Response("Not found", { status: 404 })
  }

  // The personal collection is password-gated: without a valid unlock cookie,
  // none of its objects (manifest, signatures, thumbnails, originals) are served.
  if (isGatedBucket(bucket) && !hasValidUnlock(request)) {
    return new Response("Forbidden", { status: 403 })
  }

  const objectUrl = new URL(
    `/storage/v1/object/${bucket}/${encodeStoragePath(objectPath.join("/"))}`,
    SUPABASE_URL
  )
  const headers = new Headers({
    apikey: key,
    authorization: `Bearer ${key}`,
  })
  const range = request.headers.get("range")
  if (range) headers.set("range", range)

  const storageResponse = await fetch(objectUrl, { headers })
  if (!storageResponse.ok) {
    return new Response(storageResponse.statusText || "Not found", {
      status: storageResponse.status,
    })
  }

  // Caching policy turns on two things: whether the object is content-addressed
  // and whether the bucket is gated.
  //
  //  - Thumbnails and originals are keyed by a hash of their bytes (see the seeder),
  //    so a given URL's content never changes. Cache them hard so a generate does
  //    not re-pay the Supabase round-trip for every placed tile — the main lever
  //    for fast generation. Gated objects stay `private` (cached per-device, behind
  //    the unlock cookie); public objects also carry `s-maxage` so a shared CDN
  //    (e.g. Vercel's edge) can serve them without hitting this route at all.
  //  - The mutable library files (manifest, signatures) must stay fresh so a
  //    re-seed is picked up: gated ones are never stored (a shared cache must never
  //    serve them to someone who never unlocked), public ones keep their short
  //    upstream TTL.
  //
  // `force-dynamic` (above) is kept: this handler authorizes every request, and it
  // does not strip the explicit Cache-Control we set here — that header is what a
  // CDN/browser keys on — so there is no need to relax it for the public path.
  const gated = isGatedBucket(bucket)
  const immutable = objectPath[0] === "thumbs" || objectPath[0] === "originals"
  const responseHeaders = new Headers()
  for (const header of PASSTHROUGH_HEADERS) {
    // cache-control is always set explicitly below; for gated objects also drop
    // the upstream validators so no shared cache can revalidate and re-serve them.
    if (header === "cache-control") continue
    if (gated && (header === "etag" || header === "last-modified")) continue
    const value = storageResponse.headers.get(header)
    if (value) responseHeaders.set(header, value)
  }
  if (immutable) {
    responseHeaders.set(
      "cache-control",
      gated
        ? "private, max-age=31536000, immutable"
        : "public, s-maxage=31536000, max-age=31536000, immutable"
    )
    if (gated) responseHeaders.set("vary", "Cookie")
  } else if (gated) {
    responseHeaders.set("cache-control", "private, no-store")
    responseHeaders.set("vary", "Cookie")
  } else {
    const upstream = storageResponse.headers.get("cache-control")
    if (upstream) responseHeaders.set("cache-control", upstream)
  }

  return new Response(storageResponse.body, {
    status: storageResponse.status,
    headers: responseHeaders,
  })
}
