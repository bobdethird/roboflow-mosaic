// Same-origin proxy for Roboflow bytes the browser is not allowed to fetch.
//
// The API key never leaves the server. The export link does — it is a
// capability URL for one public dataset zip — but a page on this origin cannot
// Range-read `app.roboflow.com` (CORS). The tab therefore asks this host, which
// forwards the Range and streams the 206 back.

const EXPORT_HOST = "app.roboflow.com"
const ICON_HOST = "source.roboflow.com"

export function isAllowedProxyUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== "https:") return false
  const host = url.hostname.toLowerCase()
  if (host === EXPORT_HOST) {
    return /^\/ds\/[A-Za-z0-9_-]+$/.test(url.pathname)
  }
  if (host === ICON_HOST) {
    return url.pathname.length > 1 && !url.pathname.includes("..")
  }
  return false
}

export function proxyTargetUrl(request: Request): string | null {
  const raw = new URL(request.url).searchParams.get("u")?.trim()
  if (!raw || !isAllowedProxyUrl(raw)) return null
  return raw
}

export async function proxyRoboflow(request: Request): Promise<Response> {
  const target = proxyTargetUrl(request)
  if (!target) {
    return Response.json({ error: "That URL cannot be proxied." }, { status: 400 })
  }

  const headers = new Headers()
  const range = request.headers.get("range")
  if (range) headers.set("range", range)

  let upstream: Response
  try {
    upstream = await fetch(target, {
      headers,
      cache: "no-store",
      redirect: "follow",
      signal: request.signal,
    })
  } catch {
    return Response.json(
      { error: "Could not reach the Roboflow export host." },
      { status: 502 }
    )
  }

  const out = new Headers()
  const copy = [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
  ]
  for (const name of copy) {
    const value = upstream.headers.get(name)
    if (value) out.set(name, value)
  }
  out.set("cache-control", "no-store")

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  })
}

export function exportProxyUrl(link: string): string {
  return `/api/roboflow/proxy?u=${encodeURIComponent(link)}`
}
