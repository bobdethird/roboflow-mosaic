// Roboflow Universe dataset identity: URL parsing, cache slugs, and the client
// URLs for an ingested dataset's library files.
//
// This module is shared by the browser and the server, so it must stay free of
// node-only imports (the ingest itself lives in `lib/roboflow-ingest.ts`).

export type RoboflowRef = {
  workspace: string
  project: string
  // null when the URL did not name a version; the server resolves the latest.
  version: number | null
}

export type RoboflowDataset = RoboflowRef & {
  version: number
  slug: string
  // Human label, from the Roboflow project record when available.
  name: string
  imageCount: number
  // Roboflow project type (object-detection, classification, ...).
  type?: string
  universeUrl: string
  // Whether the project's cover image was fetched during the ingest. Local
  // folder ingests and projects without a cover leave this false, and then the
  // median is the only reference available.
  hasIcon?: boolean
}

const ROBOFLOW_HOSTS = new Set([
  "universe.roboflow.com",
  "app.roboflow.com",
  "roboflow.com",
  "www.roboflow.com",
])

// Path segments that sit between the project and its version number in the
// various Roboflow URL shapes (/dataset/3, /model/3, /browse, ...).
const IGNORED_SEGMENTS = new Set([
  "dataset",
  "datasets",
  "model",
  "models",
  "browse",
  "health",
  "images",
  "deploy",
  "visualize",
])

const SLUG_RE = /^[a-zA-Z0-9._-]+$/

export class RoboflowUrlError extends Error {}

// Accepts any of:
//   https://universe.roboflow.com/<workspace>/<project>
//   https://universe.roboflow.com/<workspace>/<project>/dataset/<version>
//   https://universe.roboflow.com/<workspace>/<project>/model/<version>
//   https://app.roboflow.com/<workspace>/<project>/<version>
//   <workspace>/<project>[/<version>]
export function parseRoboflowUrl(input: string): RoboflowRef {
  const raw = input.trim()
  if (!raw) throw new RoboflowUrlError("Enter a Roboflow dataset URL.")

  let path = raw
  if (/^[a-z]+:\/\//i.test(raw) || /^[\w.-]+\.[a-z]{2,}\//i.test(raw)) {
    let url: URL
    try {
      url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`)
    } catch {
      throw new RoboflowUrlError(`Could not read that as a URL: ${raw}`)
    }
    if (!ROBOFLOW_HOSTS.has(url.hostname.toLowerCase())) {
      throw new RoboflowUrlError(
        `${url.hostname} is not a Roboflow URL — expected universe.roboflow.com.`
      )
    }
    path = url.pathname
  }

  const segments = path.split("/").filter(Boolean).map(decodeURIComponent)
  if (segments.length < 2) {
    throw new RoboflowUrlError(
      "That URL is missing the workspace or project — expected " +
        "universe.roboflow.com/<workspace>/<project>."
    )
  }

  const [workspace, project, ...rest] = segments
  if (!SLUG_RE.test(workspace) || !SLUG_RE.test(project)) {
    throw new RoboflowUrlError("The workspace or project name looks malformed.")
  }

  let version: number | null = null
  for (const segment of rest) {
    if (IGNORED_SEGMENTS.has(segment.toLowerCase())) continue
    if (/^\d+$/.test(segment)) {
      version = Number(segment)
      break
    }
  }

  return { workspace, project, version }
}

// Cache-directory / URL key for one dataset version. Kept filesystem-safe and
// collision-free: workspace and project slugs never contain "--".
export function datasetSlug(ref: RoboflowRef & { version: number }): string {
  return `${ref.workspace}--${ref.project}--v${ref.version}`
}

export function isDatasetSlug(value: string): boolean {
  return /^[a-zA-Z0-9._-]+--[a-zA-Z0-9._-]+--v\d+$/.test(value)
}

// Inverse of `datasetSlug`, for the routes that are handed a slug rather than a
// URL. Returns null when the slug is malformed.
export function parseDatasetSlug(
  slug: string
): (RoboflowRef & { version: number }) | null {
  if (!isDatasetSlug(slug)) return null
  const [workspace, project, versionTag] = slug.split("--")
  return { workspace, project, version: Number(versionTag.slice(1)) }
}

export function universeUrl(ref: RoboflowRef & { version: number }): string {
  return `https://universe.roboflow.com/${ref.workspace}/${ref.project}/dataset/${ref.version}`
}

// ─── Client-side URLs for an ingested dataset ────────────────────────────────

export const ROBOFLOW_ASSET_BASE = "/api/roboflow/asset"
export const ROBOFLOW_INGEST_PATH = "/api/roboflow/ingest"
export const ROBOFLOW_COVER_PATH = "/api/roboflow/cover"

export const MANIFEST_FILE = "manifest.json"
export const COARSE_SIGNATURES_FILE = "signatures-coarse.bin"
// The dataset's median image, computed during the ingest. Not offered in the
// UI any more (the reference is the cover or an image out of the dataset), but
// still written — it is what `isIngested` checks for, and it is the natural
// fallback for a project with no cover.
export const REFERENCE_FILE = "reference.jpg"
// The project's cover image, downloaded from Roboflow during the ingest.
export const ICON_FILE = "icon.jpg"

export function roboflowAssetUrl(slug: string, path: string): string {
  const encoded = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
  return `${ROBOFLOW_ASSET_BASE}/${encodeURIComponent(slug)}/${encoded}`
}

export function roboflowThumbPath(id: string): string {
  return `thumbs/${id}.jpg`
}

// Read a JSON body from one of the routes above.
//
// A route that never got to run — a function that crashed on load, a platform
// timeout, a 404 — answers with an HTML error page, and `response.json()` then
// reports a syntax error about "<!DOCTYPE" that says nothing about the real
// failure. Parse the text ourselves so those cases name the status instead.
export async function readJsonBody<T>(response: Response): Promise<T> {
  const text = await response.text()
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(
      `The server returned ${response.status} ${response.statusText || "error"} instead of JSON.`
    )
  }
}

// ─── Ingest job status (shared by the route and the page) ────────────────────

export type IngestState = "pending" | "running" | "ready" | "error"

export type IngestStatus = {
  slug: string
  state: IngestState
  // Coarse stage label, e.g. "Downloading export".
  step: string
  done: number
  total: number
  updatedAt: string
  error?: string
  dataset?: RoboflowDataset
}
