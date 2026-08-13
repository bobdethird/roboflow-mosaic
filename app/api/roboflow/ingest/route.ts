// Prepare (POST) a Roboflow Universe dataset for the browser to ingest, and
// poll (GET) a library that was previously published to this host.
//
// Tile decode used to run in this function. It now runs in the tab: POST only
// resolves the version and asks Roboflow for an export link. GET remains for
// datasets that already have a published library on disk or Blob.

import {
  MANIFEST_FILE,
  RoboflowUrlError,
  datasetSlug,
  isDatasetSlug,
  newerStatus,
  parseRoboflowUrl,
  universeUrl,
  type IngestStatus,
  type PreparedExport,
  type RoboflowDataset,
} from "@/lib/roboflow"
import { exportFormats, fetchExportLink, RoboflowApiError } from "@/lib/roboflow-api"
import { IngestError, hasIconFile, isIngested, resolveDataset } from "@/lib/roboflow-ingest"
import {
  consumeGlobalIngestRateLimit,
  consumeIngestRateLimit,
  ingestLeaseHeld,
} from "@/lib/roboflow-control"
import {
  blobEnabled,
  readBlobStatus,
  readBlobText,
} from "@/lib/roboflow-blob"
import { exportProxyUrl, isAllowedProxyUrl } from "@/lib/roboflow-proxy"
import {
  IS_VERCEL,
  datasetDir,
  isRunning,
  readStatus,
} from "@/lib/roboflow-store"
import { readFile } from "node:fs/promises"
import path from "node:path"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// Waiting on Roboflow to generate an export can take a couple of minutes.
export const maxDuration = 120

// How long a "running" status may sit untouched before it stops being believed.
// A running ingest refreshes the durable copy every 10 seconds, so this allows
// several missed writes.
const STALE_RUNNING_MS = 60_000

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

function json(
  body: unknown,
  status = 200,
  extraHeaders: HeadersInit = {}
): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...extraHeaders },
  })
}

function clientAddress(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown"
  )
}

function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin")
  if (!origin) return true
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

// The freshest record of this ingest, then a reconstructed one from a published
// library.
//
// The instance running the job has the freshest copy by definition, and asking
// Blob on every poll of it would cost a request per 700ms tick. Anywhere else
// the local file may be an attempt this instance abandoned an hour ago while the
// live run reports from another, so the newer of the two wins. Preferring the
// local file unconditionally is what let a poll declare a live ingest dead.
async function loadStatus(slug: string): Promise<IngestStatus | null> {
  const local = await readStatus(slug)
  if (local && isRunning(slug)) return local
  const durable = blobEnabled() ? await readBlobStatus(slug) : null
  return newerStatus(local, durable) ?? (await statusFromDisk(slug))
}

// Status for a dataset whose files are on disk but whose status.json is gone
// (an older ingest, or a manually copied cache directory).
async function statusFromDisk(slug: string): Promise<IngestStatus | null> {
  if (!(await isIngested(slug))) return null
  let imageCount = 0
  let libraryVersion: string | undefined
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
    const manifest = JSON.parse(raw) as { photos?: unknown[]; version?: string }
    imageCount = manifest.photos?.length ?? 0
    libraryVersion = manifest.version
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
    libraryVersion,
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

export async function GET(request: Request): Promise<Response> {
  const slug = new URL(request.url).searchParams.get("slug")?.trim()
  if (!slug || !isDatasetSlug(slug)) {
    return json({ error: "Missing or malformed slug." }, 400)
  }
  const raw = await loadStatus(slug)
  if (!raw) return json({ error: "Unknown dataset." }, 404)
  // The ingesting instance still says "running" while it uploads the library;
  // any other instance should prefer the published copy once it exists.
  if (raw.state === "running" && !isRunning(slug)) {
    const published = await statusFromDisk(slug)
    if (published) return json(published)
    // A status that has stopped moving is the symptom of a dead worker, not
    // proof of one: the ingest may just have failed to write it. Only the lease
    // says whether a job is still alive, and only Blob has one — without a
    // store, no ingest outlives its own instance anyway, so silence is death.
    const stale = Date.now() - Date.parse(raw.updatedAt) > STALE_RUNNING_MS
    if (stale && !(blobEnabled() && (await ingestLeaseHeld(slug)))) {
      return json({
        ...raw,
        state: "error",
        error: `The ingest stopped unexpectedly at "${raw.step}". Try again.`,
      })
    }
  }
  return json(raw)
}

export async function POST(request: Request): Promise<Response> {
  let body: { url?: string; refresh?: boolean }
  try {
    body = (await request.json()) as { url?: string; refresh?: boolean }
  } catch {
    return json({ error: "Expected a JSON body with a `url`." }, 400)
  }

  if (IS_VERCEL && !isSameOrigin(request)) {
    return json({ error: "Cross-origin ingest requests are not allowed." }, 403)
  }

  try {
    const ref = parseRoboflowUrl(body.url ?? "")

    // A URL that names its version identifies a cache entry on its own, so an
    // already-published dataset can be reopened without calling Roboflow at all.
    if (ref.version !== null && !body.refresh) {
      const known = datasetSlug({ ...ref, version: ref.version })
      if (await isIngested(known)) {
        const cached = await loadStatus(known)
        if (cached?.state === "ready") return json(cached)
      }
    }

    if (IS_VERCEL && blobEnabled()) {
      const rate = await consumeIngestRateLimit(clientAddress(request))
      if (!rate.allowed) {
        return json(
          {
            error: `Too many dataset ingests. Try again in ${rate.retryAfterSeconds} seconds.`,
            retryAfter: rate.retryAfterSeconds,
          },
          429,
          {
            "retry-after": String(rate.retryAfterSeconds),
            "x-ratelimit-limit": String(rate.limit),
            "x-ratelimit-remaining": String(rate.remaining),
          }
        )
      }
      const globalRate = await consumeGlobalIngestRateLimit()
      if (!globalRate.allowed) {
        return json(
          {
            error: `Dataset ingestion is busy. Try again in ${globalRate.retryAfterSeconds} seconds.`,
            retryAfter: globalRate.retryAfterSeconds,
          },
          429,
          { "retry-after": String(globalRate.retryAfterSeconds) }
        )
      }
    }

    const resolved = await resolveDataset(ref)
    const slug = datasetSlug(resolved.ref)

    if (!body.refresh && (await isIngested(slug))) {
      const cached = await loadStatus(slug)
      if (cached?.state === "ready") return json(cached)
    }

    const { link } = await fetchExportLink(
      resolved.ref,
      exportFormats(resolved.type),
      () => undefined
    )

    const iconUrl =
      resolved.iconUrl && isAllowedProxyUrl(resolved.iconUrl)
        ? exportProxyUrl(resolved.iconUrl)
        : undefined

    const dataset: RoboflowDataset = {
      ...resolved.ref,
      slug,
      name: resolved.name,
      type: resolved.type,
      imageCount: 0,
      sourceImages: resolved.images || undefined,
      universeUrl: universeUrl(resolved.ref),
      hasIcon: Boolean(iconUrl),
    }

    const prepared: PreparedExport & IngestStatus = {
      slug,
      state: "prepared",
      step: "Preparing export",
      done: 0,
      total: 0,
      updatedAt: new Date().toISOString(),
      exportUrl: exportProxyUrl(link),
      iconUrl,
      dataset,
    }
    return json(prepared)
  } catch (error) {
    return json({ error: errorMessage(error) }, 400)
  }
}
