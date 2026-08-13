// Start (POST) and poll (GET) the ingest of a Roboflow Universe dataset.
//
// An ingest downloads a multi-hundred-megabyte export and re-encodes every
// image, so it runs in the background and writes its progress to the dataset's
// status.json; the page polls GET until the state is "ready" or "error".

import {
  RoboflowUrlError,
  datasetSlug,
  parseRoboflowUrl,
  universeUrl,
  type IngestStatus,
  type RoboflowDataset,
} from "@/lib/roboflow"
import { RoboflowApiError } from "@/lib/roboflow-api"
import {
  IngestError,
  hasIconFile,
  ingestDataset,
  isIngested,
  resolveDataset,
} from "@/lib/roboflow-ingest"
import { blobEnabled, readBlobText } from "@/lib/roboflow-blob"
import {
  isRunning,
  progressWriter,
  readStatus,
  trackJob,
  writeStatus,
} from "@/lib/roboflow-store"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { datasetDir } from "@/lib/roboflow-store"
import { MANIFEST_FILE, isDatasetSlug } from "@/lib/roboflow"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// An ingest can take a few minutes; the request itself returns immediately, but
// the background job must be allowed to keep running.
export const maxDuration = 300

function errorMessage(error: unknown): string {
  if (
    error instanceof RoboflowUrlError ||
    error instanceof RoboflowApiError ||
    error instanceof IngestError
  ) {
    return error.message
  }
  if (error instanceof Error) return error.message
  return "Ingest failed."
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  })
}

// Status for a dataset whose files are on disk but whose status.json is gone
// (an older ingest, or a manually copied cache directory).
async function statusFromDisk(slug: string): Promise<IngestStatus | null> {
  if (!(await isIngested(slug))) return null
  let imageCount = 0
  let name = slug
  try {
    const raw = await readFile(
      path.join(datasetDir(slug), MANIFEST_FILE),
      "utf8"
    ).catch(async (error: unknown) => {
      const published = blobEnabled()
        ? await readBlobText(slug, MANIFEST_FILE)
        : null
      if (published === null) throw error
      return published
    })
    const manifest = JSON.parse(raw) as { photos?: unknown[] }
    imageCount = manifest.photos?.length ?? 0
  } catch {
    // Leave the count at zero; the library load will surface a real failure.
  }
  const [workspace, project, versionTag] = slug.split("--")
  const version = Number(versionTag.slice(1))
  name = `${workspace}/${project}`
  const dataset: RoboflowDataset = {
    workspace,
    project,
    version,
    slug,
    name,
    imageCount,
    universeUrl: universeUrl({ workspace, project, version }),
    hasIcon: await hasIconFile(slug),
  }
  return {
    slug,
    state: "ready",
    step: "Ready",
    done: 0,
    total: 0,
    updatedAt: new Date().toISOString(),
    dataset,
  }
}

// The dataset record in a status.json can predate a feature — an ingest from
// before cover images were fetched has no `hasIcon` at all. The filesystem is
// the truth, so re-derive it rather than trusting a stale record.
async function withIconState(status: IngestStatus): Promise<IngestStatus> {
  if (status.state !== "ready" || !status.dataset) return status
  const hasIcon = await hasIconFile(status.slug)
  if (status.dataset.hasIcon === hasIcon) return status
  return { ...status, dataset: { ...status.dataset, hasIcon } }
}

export async function GET(request: Request): Promise<Response> {
  const slug = new URL(request.url).searchParams.get("slug")?.trim()
  if (!slug || !isDatasetSlug(slug)) {
    return json({ error: "Missing or malformed slug." }, 400)
  }
  const raw = (await readStatus(slug)) ?? (await statusFromDisk(slug))
  if (!raw) return json({ error: "Unknown dataset." }, 404)
  const status = await withIconState(raw)
  // A status file can claim "running" after a server restart killed the job.
  if (status.state === "running" && !isRunning(slug)) {
    const stale = Date.now() - Date.parse(status.updatedAt) > 60_000
    if (stale) {
      return json({
        ...status,
        state: "error",
        error: "The ingest stopped unexpectedly. Try again.",
      })
    }
  }
  return json(status)
}

export async function POST(request: Request): Promise<Response> {
  let body: { url?: string; refresh?: boolean }
  try {
    body = (await request.json()) as { url?: string; refresh?: boolean }
  } catch {
    return json({ error: "Expected a JSON body with a `url`." }, 400)
  }

  let slug: string
  let started: IngestStatus
  try {
    const ref = parseRoboflowUrl(body.url ?? "")

    // A URL that names its version identifies a cache entry on its own, so an
    // already-ingested dataset can be reopened without calling Roboflow at all
    // (and without an API key).
    if (ref.version !== null && !body.refresh) {
      const known = datasetSlug({ ...ref, version: ref.version })
      if (await isIngested(known)) {
        const cached = (await readStatus(known)) ?? (await statusFromDisk(known))
        if (cached?.state === "ready") return json(await withIconState(cached))
      }
    }

    const resolved = await resolveDataset(ref)
    slug = datasetSlug(resolved.ref)

    if (isRunning(slug)) {
      const current = await readStatus(slug)
      return json(current ?? { slug, state: "running", step: "Working", done: 0, total: 0 })
    }
    if (!body.refresh && (await isIngested(slug))) {
      const cached = (await readStatus(slug)) ?? (await statusFromDisk(slug))
      if (cached?.state === "ready") return json(await withIconState(cached))
    }

    started = {
      slug,
      state: "running",
      step: "Starting",
      done: 0,
      total: 0,
      updatedAt: new Date().toISOString(),
    }
    await writeStatus(started)

    const { report, finish } = progressWriter(slug)
    const job = ingestDataset(resolved.ref, report)
      .then(async (dataset) => {
        await finish("ready", { dataset })
      })
      .catch(async (error: unknown) => {
        await finish("error", { error: errorMessage(error) })
      })
    trackJob(slug, job)
  } catch (error) {
    return json({ error: errorMessage(error) }, 400)
  }

  return json(started, 202)
}
