// Which remote image URLs the thumb proxy will fetch. The browser prefers to
// download from Roboflow's CDN directly; this allowlist is the fallback so a
// missing CORS header cannot be turned into an open proxy.

const ALLOWED_HOSTS = [
  /(^|\.)roboflow\.com$/i,
  /(^|\.)googleapis\.com$/i,
  /(^|\.)googleusercontent\.com$/i,
  /(^|\.)amazonaws\.com$/i,
  /(^|\.)cloudfront\.net$/i,
  /(^|\.)r2\.cloudflarestorage\.com$/i,
]

export function isAllowedImageUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== "https:") return false
  return ALLOWED_HOSTS.some((pattern) => pattern.test(url.hostname))
}
