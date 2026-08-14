// Thin client for the Roboflow REST endpoints this app needs: project info
// (to resolve a cache identity and the project cover) and the per-image search
// + detail calls that feed the ingest.
//
//   GET  https://api.roboflow.com/<workspace>/<project>?api_key=…
//   POST https://api.roboflow.com/<workspace>/search/v1?api_key=…
//   GET  https://api.roboflow.com/<workspace>/<project>/images/<id>?api_key=…

import type { RoboflowRef } from "./roboflow"
import { SEARCH_PAGE_SIZE, SEARCH_RESULT_CAP } from "./roboflow-limits"

const API_URL = "https://api.roboflow.com"
const REQUEST_TIMEOUT_MS = 20_000
const MAX_RETRIES = 3

export class RoboflowApiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

export function roboflowApiKey(override?: string | null): string {
  const key =
    override?.trim() ||
    process.env.ROBOFLOW_API_KEY?.trim() ||
    process.env.NEXT_PUBLIC_ROBOFLOW_API_KEY?.trim()
  if (!key) {
    throw new RoboflowApiError(
      "ROBOFLOW_API_KEY is not set. Add it to .env.local — you can copy it from " +
        "roboflow.com → Settings → API Keys."
    )
  }
  return key
}

type ProjectVersion = {
  // "<workspace>/<project>/<version>"
  id?: string
  images?: number
  name?: string
}

export type ProjectInfo = {
  name: string
  type?: string
  // Newest version that holds images, or null when the project has no generated
  // versions. A version whose generation never finished stays in the list
  // reporting zero images; it is never what a project URL without a version
  // means, because the slug still keys the cache on a version number.
  latestVersion: number | null
  versions: number[]
  imagesByVersion: Map<number, number>
  // Full-size URL of the project's cover image, when it has one.
  iconUrl?: string
}

// `project.icon` is `{ original, thumb, annotation }` on every project seen so
// far, but tolerate a bare URL string too.
function iconUrl(icon: unknown): string | undefined {
  if (typeof icon === "string") return icon || undefined
  if (icon && typeof icon === "object") {
    const { original, thumb } = icon as Record<string, unknown>
    if (typeof original === "string" && original) return original
    if (typeof thumb === "string" && thumb) return thumb
  }
  return undefined
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  )
}

function retryDelayMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(10_000, seconds * 1000)
    }
  }
  return Math.min(8_000, 400 * 2 ** attempt)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Aborted"))
      return
    }
    const timer = setTimeout(resolve, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error("Aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function parseJsonBody(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    return {}
  }
}

function errorDetail(body: Record<string, unknown>, text: string, fallback: string) {
  return (
    (typeof body.message === "string" && body.message) ||
    (typeof body.error === "string" && body.error) ||
    text.slice(0, 200) ||
    fallback
  )
}

type ApiRequestOptions = {
  method?: string
  body?: unknown
  signal?: AbortSignal
  timeoutMs?: number
}

async function apiRequest(
  url: string,
  options: ApiRequestOptions = {}
): Promise<Record<string, unknown>> {
  const {
    method = "GET",
    body,
    signal,
    timeoutMs = REQUEST_TIMEOUT_MS,
  } = options
  let lastError: unknown = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new RoboflowApiError("The Roboflow API request was cancelled.")
    }
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
    try {
      const response = await fetch(url, {
        method,
        cache: "no-store",
        signal: combined,
        headers:
          body !== undefined
            ? { "content-type": "application/json" }
            : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      const text = await response.text()
      const parsed = parseJsonBody(text)
      if (response.status === 429 || response.status >= 500) {
        lastError = new RoboflowApiError(
          `Roboflow API ${response.status}: ${errorDetail(parsed, text, response.statusText)}`,
          response.status
        )
        if (attempt === MAX_RETRIES) throw lastError
        await sleep(retryDelayMs(attempt, response.headers.get("retry-after")), signal)
        continue
      }
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new RoboflowApiError(
            `Roboflow rejected the API key (${response.status}). Check ROBOFLOW_API_KEY in .env.local.`,
            response.status
          )
        }
        throw new RoboflowApiError(
          `Roboflow API ${response.status}: ${errorDetail(parsed, text, response.statusText)}`,
          response.status
        )
      }
      return parsed
    } catch (error) {
      if (signal?.aborted) throw error
      if (error instanceof RoboflowApiError && error.status !== 429 && (error.status ?? 0) < 500) {
        throw error
      }
      lastError = error
      if (isTimeoutError(error) && attempt < MAX_RETRIES) {
        await sleep(retryDelayMs(attempt, null), signal)
        continue
      }
      if (error instanceof RoboflowApiError) throw error
      if (isTimeoutError(error)) {
        throw new RoboflowApiError("The Roboflow API request timed out.")
      }
      throw error
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new RoboflowApiError("The Roboflow API request failed.")
}

function versionNumber(version: ProjectVersion): number | null {
  const id = version.id
  if (!id) return null
  const tail = id.split("/").pop()
  return tail && /^\d+$/.test(tail) ? Number(tail) : null
}

export async function fetchProjectInfo(
  ref: RoboflowRef,
  options: { apiKey?: string; signal?: AbortSignal } = {}
): Promise<ProjectInfo> {
  const key = roboflowApiKey(options.apiKey)
  const body = await apiRequest(
    `${API_URL}/${encodeURIComponent(ref.workspace)}/${encodeURIComponent(ref.project)}?api_key=${encodeURIComponent(key)}`,
    { signal: options.signal }
  )
  const project = (body.project ?? {}) as Record<string, unknown>
  const rawVersions = Array.isArray(body.versions)
    ? (body.versions as ProjectVersion[])
    : []

  const versions: number[] = []
  const imagesByVersion = new Map<number, number>()
  for (const entry of rawVersions) {
    const n = versionNumber(entry)
    if (n === null) continue
    versions.push(n)
    if (typeof entry.images === "number") imagesByVersion.set(n, entry.images)
  }
  versions.sort((a, b) => a - b)
  // An unreported image count is not a claim of emptiness, so only a version
  // that says zero is skipped. If every version says zero, the newest still
  // stands in — `resolveDataset` has a better error for that than "no versions".
  const withImages = versions.filter((n) => imagesByVersion.get(n) !== 0)
  const newest = withImages.length ? withImages : versions

  return {
    name:
      (typeof project.name === "string" && project.name) ||
      `${ref.workspace}/${ref.project}`,
    type: typeof project.type === "string" ? project.type : undefined,
    latestVersion: newest.length ? newest[newest.length - 1] : null,
    versions,
    imagesByVersion,
    iconUrl: iconUrl(project.icon),
  }
}

export type ProjectImage = {
  id: string
  name?: string
  url?: string
}

export type ImageSearchPage = {
  offset: number
  total: number
  results: ProjectImage[]
}

function asProjectImage(value: unknown): ProjectImage | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  if (typeof record.id !== "string" || !record.id) return null
  return {
    id: record.id,
    name: typeof record.name === "string" ? record.name : undefined,
    url: typeof record.url === "string" && record.url ? record.url : undefined,
  }
}

export async function searchProjectImages(
  ref: RoboflowRef,
  options: {
    offset?: number
    limit?: number
    signal?: AbortSignal
    apiKey?: string
  } = {}
): Promise<ImageSearchPage> {
  const key = roboflowApiKey(options.apiKey)
  const offset = Math.max(0, options.offset ?? 0)
  const limit = Math.min(
    SEARCH_PAGE_SIZE,
    Math.max(1, options.limit ?? SEARCH_PAGE_SIZE)
  )
  const body = await apiRequest(
    `${API_URL}/${encodeURIComponent(ref.workspace)}/${encodeURIComponent(ref.project)}/search?api_key=${encodeURIComponent(key)}`,
    {
      method: "POST",
      signal: options.signal,
      body: {
        in_dataset: true,
        offset,
        limit,
        fields: ["id", "name", "url"],
      },
    }
  )
  const results = Array.isArray(body.results)
    ? body.results.map(asProjectImage).filter((image): image is ProjectImage => image !== null)
    : []
  return {
    offset,
    total: typeof body.total === "number" ? body.total : results.length,
    results,
  }
}

export async function listProjectImages(
  ref: RoboflowRef,
  options: {
    max?: number
    signal?: AbortSignal
    apiKey?: string
    onPage?: (loaded: number, total: number) => void
  } = {}
): Promise<{ images: ProjectImage[]; total: number }> {
  const images: ProjectImage[] = []
  const seen = new Set<string>()
  let total = 0
  let offset = 0

  for (;;) {
    const page = await searchProjectImages(ref, {
      offset,
      limit: SEARCH_PAGE_SIZE,
      signal: options.signal,
      apiKey: options.apiKey,
    })
    total = page.total
    for (const image of page.results) {
      if (seen.has(image.id)) continue
      seen.add(image.id)
      images.push(image)
      if (options.max && images.length >= options.max) {
        options.onPage?.(images.length, total)
        return { images, total }
      }
    }
    options.onPage?.(images.length, total)
    if (!page.results.length) break
    offset += page.results.length
    if (total > 0 ? offset >= total : page.results.length < SEARCH_PAGE_SIZE) {
      break
    }
  }

  return { images, total }
}

export type ImageDetails = {
  id: string
  name?: string
  urls: {
    original?: string
    thumb?: string
  }
}

export async function fetchImageDetails(
  ref: RoboflowRef,
  imageId: string,
  options: { signal?: AbortSignal; apiKey?: string } = {}
): Promise<ImageDetails> {
  const key = roboflowApiKey(options.apiKey)
  const body = await apiRequest(
    `${API_URL}/${encodeURIComponent(ref.workspace)}/${encodeURIComponent(ref.project)}/images/${encodeURIComponent(imageId)}?api_key=${encodeURIComponent(key)}`,
    { signal: options.signal }
  )
  const image = (body.image ?? {}) as Record<string, unknown>
  const urls = (image.urls ?? {}) as Record<string, unknown>
  return {
    id: typeof image.id === "string" && image.id ? image.id : imageId,
    name: typeof image.name === "string" ? image.name : undefined,
    urls: {
      original:
        typeof urls.original === "string" && urls.original
          ? urls.original
          : undefined,
      thumb: typeof urls.thumb === "string" && urls.thumb ? urls.thumb : undefined,
    },
  }
}

// Search returns the original file URL. Roboflow's hosted originals are paired
// with a `thumb` sibling that the detail endpoint also reports.
export function thumbUrlFromSource(url: string): string | null {
  if (url.includes("/original.")) return url.replace("/original.", "/thumb.")
  if (url.endsWith("/original")) return `${url.slice(0, -"/original".length)}/thumb`
  return null
}

export async function resolveThumbUrl(
  ref: RoboflowRef,
  image: ProjectImage,
  options: { signal?: AbortSignal; apiKey?: string } = {}
): Promise<string | null> {
  if (image.url) {
    const derived = thumbUrlFromSource(image.url)
    if (derived) return derived
  }
  const details = await fetchImageDetails(ref, image.id, options)
  return details.urls.thumb ?? details.urls.original ?? image.url ?? null
}

export type ThumbnailBatchItem = {
  image: ProjectImage
  bytes: Buffer | null
}

function isFatalThumbError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  if (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  ) {
    return true
  }
  return error instanceof RoboflowApiError && /timed out/i.test(error.message)
}

export async function fetchThumbnail(
  ref: RoboflowRef,
  image: ProjectImage,
  options: { signal?: AbortSignal; apiKey?: string } = {}
): Promise<ThumbnailBatchItem> {
  try {
    const url = await resolveThumbUrl(ref, image, options)
    if (!url) return { image, bytes: null }
    return {
      image,
      bytes: await fetchBinary(url, { signal: options.signal }),
    }
  } catch (error) {
    if (isFatalThumbError(error, options.signal)) throw error
    return { image, bytes: null }
  }
}

// Every thumbnail on a search page, requested together. Isolated missing or
// corrupt images come back as `bytes: null`. A cancelled or timed-out page
// fails only when none of the page's thumbnails arrived.
export async function fetchThumbnailBatch(
  ref: RoboflowRef,
  images: ProjectImage[],
  options: { signal?: AbortSignal } = {}
): Promise<ThumbnailBatchItem[]> {
  const results = await Promise.all(
    images.map(async (image) => {
      try {
        const item = await fetchThumbnail(ref, image, options)
        return { ...item, fatal: null as unknown }
      } catch (error) {
        return { image, bytes: null, fatal: error }
      }
    })
  )
  const fatal = results.find((item) => item.fatal)?.fatal
  if (fatal && results.every((item) => !item.bytes)) throw fatal
  return results.map(({ image, bytes }) => ({ image, bytes }))
}

const MAX_BINARY_BYTES = 8 * 1024 * 1024

export async function fetchBinary(
  url: string,
  options: { signal?: AbortSignal; maxBytes?: number } = {}
): Promise<Buffer> {
  const maxBytes = options.maxBytes ?? MAX_BINARY_BYTES
  let lastError: unknown = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new RoboflowApiError("The image download was cancelled.")
    }
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    const combined = options.signal
      ? AbortSignal.any([options.signal, timeout])
      : timeout
    try {
      const response = await fetch(url, {
        cache: "no-store",
        redirect: "follow",
        signal: combined,
      })
      if (response.status === 429 || response.status >= 500) {
        lastError = new RoboflowApiError(
          `Downloading an image failed (${response.status} ${response.statusText}).`,
          response.status
        )
        if (attempt === MAX_RETRIES) throw lastError
        await sleep(
          retryDelayMs(attempt, response.headers.get("retry-after")),
          options.signal
        )
        continue
      }
      if (!response.ok) {
        throw new RoboflowApiError(
          `Downloading an image failed (${response.status} ${response.statusText}).`,
          response.status
        )
      }
      const length = Number(response.headers.get("content-length") ?? 0)
      if (length > maxBytes) {
        await response.body?.cancel()
        throw new RoboflowApiError("An image was unexpectedly large.")
      }
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length > maxBytes) {
        throw new RoboflowApiError("An image was unexpectedly large.")
      }
      return bytes
    } catch (error) {
      if (options.signal?.aborted) throw error
      if (error instanceof RoboflowApiError && error.status !== 429 && (error.status ?? 0) < 500) {
        throw error
      }
      lastError = error
      if (isTimeoutError(error) && attempt < MAX_RETRIES) {
        await sleep(retryDelayMs(attempt, null), options.signal)
        continue
      }
      if (error instanceof RoboflowApiError) throw error
      if (isTimeoutError(error)) {
        throw new RoboflowApiError("The image download timed out.")
      }
      throw error
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new RoboflowApiError("The image download failed.")
}
