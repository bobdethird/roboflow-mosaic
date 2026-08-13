// Start (POST) and poll (GET) the ingest of a Roboflow Universe dataset.
//
// An ingest downloads a multi-hundred-megabyte export and re-encodes every
// image, so it runs in the background and writes its progress to the dataset's
// status.json; the page polls GET until the state is "ready" or "error".

import { after } from "next/server"

import {
  MANIFEST_FILE,
  RoboflowUrlError,
  datasetSlug,
  isDatasetSlug,
  newerStatus,
  parseRoboflowUrl,
  universeUrl,
  type IngestStatus,
  type RoboflowDataset,
} from "@/lib/roboflow"
import { RoboflowApiError } from "@/lib/roboflow-api"
import {
  IngestError,
  VERCEL_INGEST_DEADLINE_MS,
  hasIconFile,
  ingestDataset,
  isIngested,
  resolveDataset,
} from "@/lib/roboflow-ingest"
import {
  acquireIngestLease,
  consumeGlobalIngestRateLimit,
  consumeIngestRateLimit,
  ingestLeaseHeld,
  releaseIngestLease,
  type IngestLease,
} from "@/lib/roboflow-control"
import {
  blobEnabled,
  readBlobStatus,
  readBlobText,
  writeBlobStatus,
} from "@/lib/roboflow-blob"
import {
  IS_VERCEL,
  datasetDir,
  isRunning,
  progressWriter,
  readStatus,
  releaseJobReservation,
  reserveJob,
  trackJob,
  writeStatus,
} from "@/lib/roboflow-store"
import { readFile } from "node:fs/promises"
import path from "node:path"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
// An ingest can take a few minutes; the request itself returns immediately, but
// the background job must be allowed to keep running.
export const maxDuration = 300

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

async function persistStatus(status: IngestStatus): Promise<void> {
  await writeStatus(status)
  if (blobEnabled()) await writeBlobStatus(status.slug, status)
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
  const deadline = IS_VERCEL
    ? Date.now() + VERCEL_INGEST_DEADLINE_MS
    : undefined
  let body: { url?: string; refresh?: boolean }
  try {
    body = (await request.json()) as { url?: string; refresh?: boolean }
  } catch {
    return json({ error: "Expected a JSON body with a `url`." }, 400)
  }

  // A serverless instance keeps nothing, so the library has to have somewhere
  // durable to go. Without a Blob store the ingest would succeed and then be
  // unreachable from the very next request, which lands on another instance.
  if (IS_VERCEL && !blobEnabled()) {
    return json(
      {
        error:
          "Dataset storage is not configured. Connect a Vercel Blob store and redeploy.",
      },
      503
    )
  }
  if (IS_VERCEL && !isSameOrigin(request)) {
    return json({ error: "Cross-origin ingest requests are not allowed." }, 403)
  }

  let slug: string
  let reservedSlug: string | null = null
  let distributedLease: IngestLease | null = null
  let started: IngestStatus
  try {
    const ref = parseRoboflowUrl(body.url ?? "")

    // A URL that names its version identifies a cache entry on its own, so an
    // already-ingested dataset can be reopened without calling Roboflow at all
    // (and without an API key).
    if (ref.version !== null && !body.refresh) {
      const known = datasetSlug({ ...ref, version: ref.version })
      if (await isIngested(known)) {
        const cached = await loadStatus(known)
        if (cached?.state === "ready") return json(cached)
      }
    }

    if (IS_VERCEL) {
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
    slug = datasetSlug(resolved.ref)

    if (isRunning(slug)) {
      const current = await loadStatus(slug)
      return json(
        current ?? {
          slug,
          state: "running",
          step: "Working",
          done: 0,
          total: 0,
        }
      )
    }
    if (!body.refresh && (await isIngested(slug))) {
      const cached = await loadStatus(slug)
      if (cached?.state === "ready") return json(cached)
    }

    if (!reserveJob(slug)) {
      return json(
        {
          error:
            "Another dataset is already being prepared on this server. Try again shortly.",
        },
        429
      )
    }
    reservedSlug = slug

    if (IS_VERCEL) {
      distributedLease = await acquireIngestLease(slug)
      if (!distributedLease) {
        releaseJobReservation(slug)
        reservedSlug = null
        const current = await loadStatus(slug)
        return json(
          current ?? {
            slug,
            state: "running",
            step: "Starting on another server",
            done: 0,
            total: 0,
            updatedAt: new Date().toISOString(),
          },
          202
        )
      }
    }

    started = {
      slug,
      state: "running",
      step: "Starting",
      done: 0,
      total: 0,
      updatedAt: new Date().toISOString(),
    }
    // Durable write before 202: the next poll almost always hits another
    // instance, and without this that GET 404s ("Unknown dataset").
    await persistStatus(started)

    const { report, finish } = progressWriter(slug, {
      durable: blobEnabled()
        ? (status) => writeBlobStatus(status.slug, status)
        : undefined,
    })
    const lease = distributedLease
    distributedLease = null
    const job = ingestDataset(resolved.ref, report, { resolved, deadline })
      .then(async (dataset) => {
        await finish("ready", { dataset })
      })
      .catch(async (error: unknown) => {
        await finish("error", { error: errorMessage(error) })
      })
      .finally(async () => {
        if (lease) await releaseIngestLease(lease).catch(() => undefined)
      })
    trackJob(slug, job)
    reservedSlug = null
    // Keep the invocation alive after the 202. Without this, Vercel may freeze
    // the function as soon as the response is sent and the ingest never runs.
    after(async () => {
      await job
    })
  } catch (error) {
    if (reservedSlug) releaseJobReservation(reservedSlug)
    if (distributedLease) {
      await releaseIngestLease(distributedLease).catch(() => undefined)
    }
    return json({ error: errorMessage(error) }, 400)
  }

  return json(started, 202)
}
