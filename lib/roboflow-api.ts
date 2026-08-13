// Thin client for the two Roboflow REST endpoints this app needs: project info
// (to resolve the latest version and the project type) and a version export (to
// get a zip download link).
//
//   GET https://api.roboflow.com/<workspace>/<project>?api_key=…
//   GET https://api.roboflow.com/<workspace>/<project>/<version>/<format>?api_key=…
//
// The export endpoint answers either with `{ export: { link } }` or, while
// Roboflow is still generating the zip, `{ ready: false, progress }` — so the
// call polls until the link appears.

import type { RoboflowRef } from "./roboflow"

const API_URL = "https://api.roboflow.com"
const REQUEST_TIMEOUT_MS = 20_000

export class RoboflowApiError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

export function roboflowApiKey(): string {
  const key =
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
  // Newest version number, or null when the project has no generated versions.
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

// Roboflow rejects an unknown export format outright, and the valid set depends
// on the project type. These are the formats that simply contain the images.
const FORMATS_BY_TYPE: Record<string, string[]> = {
  "object-detection": ["coco", "yolov8", "voc"],
  "instance-segmentation": ["coco-segmentation", "coco", "yolov8"],
  "semantic-segmentation": ["png-mask-semantic", "coco-segmentation", "coco"],
  classification: ["folder", "multiclass", "clip"],
  "single-label-classification": ["folder", "multiclass"],
  "multi-label-classification": ["multiclass", "folder"],
  keypoint: ["coco-keypoints", "coco", "yolov8"],
}

const FALLBACK_FORMATS = ["coco", "yolov8", "folder", "voc", "multiclass"]

// Candidate export formats for a project, best guess first. Every one of them
// ships the same images; only the annotation sidecars differ, and the ingest
// ignores those.
export function exportFormats(type: string | undefined): string[] {
  const preferred = type ? (FORMATS_BY_TYPE[type] ?? []) : []
  return [...new Set([...preferred, ...FALLBACK_FORMATS])]
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  let response: Response
  try {
    response = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === "AbortError" || error.name === "TimeoutError")
    ) {
      throw new RoboflowApiError("The Roboflow API request timed out.")
    }
    throw error
  }
  const text = await response.text()
  let body: Record<string, unknown> = {}
  try {
    body = JSON.parse(text) as Record<string, unknown>
  } catch {
    // Non-JSON body (an HTML error page); fall through to the status handling.
  }
  if (!response.ok) {
    const detail =
      (typeof body.message === "string" && body.message) ||
      (typeof body.error === "string" && body.error) ||
      text.slice(0, 200) ||
      response.statusText
    if (response.status === 401 || response.status === 403) {
      throw new RoboflowApiError(
        `Roboflow rejected the API key (${response.status}). Check ROBOFLOW_API_KEY in .env.local.`,
        response.status
      )
    }
    throw new RoboflowApiError(
      `Roboflow API ${response.status}: ${detail}`,
      response.status
    )
  }
  return body
}

function versionNumber(version: ProjectVersion): number | null {
  const id = version.id
  if (!id) return null
  const tail = id.split("/").pop()
  return tail && /^\d+$/.test(tail) ? Number(tail) : null
}

export async function fetchProjectInfo(ref: RoboflowRef): Promise<ProjectInfo> {
  const key = roboflowApiKey()
  const body = await getJson(
    `${API_URL}/${encodeURIComponent(ref.workspace)}/${encodeURIComponent(ref.project)}?api_key=${encodeURIComponent(key)}`
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

  return {
    name:
      (typeof project.name === "string" && project.name) ||
      `${ref.workspace}/${ref.project}`,
    type: typeof project.type === "string" ? project.type : undefined,
    latestVersion: versions.length ? versions[versions.length - 1] : null,
    versions,
    imagesByVersion,
    iconUrl: iconUrl(project.icon),
  }
}

export type ExportLink = { link: string; format: string }

// Ask for a version export and wait for the zip link. Roboflow generates the
// export on demand, so a not-ready response is normal on the first call. An
// already-generated export is reused — forcing a rebuild (`nocache`) made every
// ingest wait on Roboflow's zip job before the download even started.
export async function fetchExportLink(
  ref: RoboflowRef & { version: number },
  formats: string[],
  onProgress: (message: string) => void,
  timeoutMs = 180_000
): Promise<ExportLink> {
  const key = roboflowApiKey()
  const deadline = Date.now() + timeoutMs
  let lastError: unknown = null

  for (const format of formats) {
    const url =
      `${API_URL}/${encodeURIComponent(ref.workspace)}/${encodeURIComponent(ref.project)}` +
      `/${ref.version}/${encodeURIComponent(format)}?api_key=${encodeURIComponent(key)}`
    try {
      while (Date.now() < deadline) {
        const body = await getJson(url)
        const exportBlock = body.export as { link?: string } | undefined
        const link = exportBlock?.link
        if (typeof link === "string" && link) return { link, format }
        if (body.ready === false) {
          const pct =
            typeof body.progress === "number"
              ? ` (${Math.round(body.progress * 100)}%)`
              : ""
          onProgress(`Roboflow is generating the ${format} export${pct}`)
          await new Promise((resolve) => setTimeout(resolve, 1500))
          continue
        }
        throw new RoboflowApiError(
          `Roboflow returned no export link for format "${format}".`
        )
      }
      throw new RoboflowApiError(
        `Timed out waiting for Roboflow to generate the ${format} export.`
      )
    } catch (error) {
      // An unsupported format for this project type is a 4xx; try the next one.
      lastError = error
      if (error instanceof RoboflowApiError && error.status === 401) throw error
      if (error instanceof RoboflowApiError && error.status === 403) throw error
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new RoboflowApiError("Could not export this dataset in any known format.")
}
