// Server-side store for ingested Roboflow datasets.
//
// Each dataset version gets one directory under the cache root:
//
//   <cache>/<slug>/manifest.json           { version, photos: [{ id, w, h }] }
//   <cache>/<slug>/signatures-coarse.bin   uint16 LE coarse signatures, in photo order
//   <cache>/<slug>/thumbs/<id>.jpg         one thumbnail per photo
//   <cache>/<slug>/icon.jpg                the project's cover image
//   <cache>/<slug>/status.json             ingest progress / result
//
// Ingests are long-running, so the route starts one in the background and the
// page polls status.json. `runningJobs` keeps a single process from starting the
// same ingest twice.

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import path from "node:path"

import type { IngestStatus, RoboflowDataset } from "./roboflow"
import { isDatasetSlug } from "./roboflow"

// On a serverless host the deployment directory is read-only and /tmp is the
// only place an ingest can build. Status lives under this root; large build
// files use isolated .jobs directories and are removed after Blob publication.
export const IS_VERCEL = process.env.VERCEL === "1"

const DEFAULT_CACHE_ROOT = IS_VERCEL
  ? "/tmp/roboflow-cache"
  : path.join(process.cwd(), ".roboflow-cache")

export const CACHE_ROOT = path.resolve(
  process.env.ROBOFLOW_CACHE_DIR?.trim() || DEFAULT_CACHE_ROOT
)

export function datasetDir(slug: string): string {
  if (!isDatasetSlug(slug)) throw new Error(`Invalid dataset slug: ${slug}`)
  return path.join(CACHE_ROOT, slug)
}

const JOBS_DIR = path.join(CACHE_ROOT, ".jobs")
// A function is configured for five minutes. Anything this old cannot still be
// one of our live jobs, even if a hard timeout prevented its `finally` cleanup.
const STALE_JOB_MS = 15 * 60 * 1000

async function removeStaleWorkDirectories(): Promise<void> {
  const entries = await readdir(JOBS_DIR, { withFileTypes: true }).catch(
    () => []
  )
  const cutoff = Date.now() - STALE_JOB_MS
  await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const directory = path.join(JOBS_DIR, entry.name)
        const info = await stat(directory).catch(() => null)
        if (info && info.mtimeMs < cutoff) {
          await rm(directory, { recursive: true, force: true })
        }
      })
  )
}

// Serverless builds use an isolated, disposable directory. Status remains in
// `datasetDir(slug)`, so removing work files cannot make polling lose the job.
// Local development intentionally keeps the finished library as its cache.
export async function createIngestDirectory(slug: string): Promise<string> {
  if (!IS_VERCEL) return datasetDir(slug)
  if (!isDatasetSlug(slug)) throw new Error(`Invalid dataset slug: ${slug}`)
  await mkdir(JOBS_DIR, { recursive: true })
  await removeStaleWorkDirectories()
  return mkdtemp(path.join(JOBS_DIR, `${slug}-`))
}

// Resolve a request path inside a dataset directory, refusing anything that
// escapes it when a caller passes user-controlled segments.
export function datasetFile(slug: string, relativePath: string): string | null {
  const base = datasetDir(slug)
  const resolved = path.resolve(base, relativePath)
  const prefix = base + path.sep
  return resolved === base || resolved.startsWith(prefix) ? resolved : null
}

export const STATUS_FILE = "status.json"

export function statusPath(slug: string): string {
  return path.join(datasetDir(slug), STATUS_FILE)
}

export async function readStatus(slug: string): Promise<IngestStatus | null> {
  try {
    const raw = await readFile(statusPath(slug), "utf8")
    return JSON.parse(raw) as IngestStatus
  } catch {
    return null
  }
}

// Written atomically: the page polls this file while the ingest writes it, and a
// half-written JSON would surface as a spurious error.
export async function writeStatus(status: IngestStatus): Promise<void> {
  const dir = datasetDir(status.slug)
  await mkdir(dir, { recursive: true })
  const target = statusPath(status.slug)
  const tmp = `${target}.tmp`
  await writeFile(tmp, JSON.stringify(status, null, 2))
  await rename(tmp, target)
}

export type ProgressReporter = (
  step: string,
  done?: number,
  total?: number
) => void

// How often a running ingest refreshes the durable (Blob) copy of status.json.
// GET on another instance treats a running status older than 60s as dead, so
// this has to be comfortably under that.
const DURABLE_INTERVAL_MS = 10_000

// Build a reporter that persists coarse progress, throttled so a per-image
// callback doesn't turn into thousands of writes.
export function progressWriter(
  slug: string,
  options: {
    onError?: (error: unknown) => void
    // Cross-instance copy (Blob). Step changes and finish always go; counter
    // ticks are rate-limited so a per-image callback doesn't become a PUT storm.
    durable?: (status: IngestStatus) => Promise<void>
  } = {}
): {
  report: ProgressReporter
  finish: (
    state: "ready" | "error",
    extra: { dataset?: RoboflowDataset; error?: string }
  ) => Promise<void>
} {
  const onError = options.onError ?? (() => {})
  let lastWrite = 0
  let lastStep = ""
  let lastDurable = 0
  let lastDurableStep = ""
  // Reports are fire-and-forget, but their writes still have to be ordered.
  // Otherwise two calls race on status.json.tmp and one rename fails ENOENT.
  let pending = Promise.resolve()

  const persist = (status: IngestStatus, forceDurable: boolean) => {
    const durable =
      options.durable &&
      (forceDurable ||
        status.step !== lastDurableStep ||
        Date.now() - lastDurable >= DURABLE_INTERVAL_MS)
    if (durable) {
      lastDurable = Date.now()
      lastDurableStep = status.step
    }
    const write = pending
      .catch(() => undefined)
      .then(async () => {
        const writes = [writeStatus(status)]
        if (durable && options.durable) writes.push(options.durable(status))
        await Promise.all(writes)
      })
    pending = write
    return write
  }

  const report: ProgressReporter = (step, done = 0, total = 0) => {
    const now = Date.now()
    // Persist a stage change immediately; rate-limit the counter updates within
    // a stage so a per-image callback doesn't hammer the disk.
    if (step === lastStep && now - lastWrite < 400) return
    lastStep = step
    lastWrite = now
    void persist(
      {
        slug,
        state: "running",
        step,
        done,
        total,
        updatedAt: new Date().toISOString(),
      },
      false
    ).catch(onError)
  }

  const finish = async (
    state: "ready" | "error",
    extra: { dataset?: RoboflowDataset; error?: string }
  ) => {
    await persist(
      {
        slug,
        state,
        step: state === "ready" ? "Ready" : "Failed",
        done: 0,
        total: 0,
        updatedAt: new Date().toISOString(),
        ...extra,
      },
      true
    )
  }

  return { report, finish }
}

// Slugs whose ingest is running in this process.
const runningJobs = new Map<string, Promise<void>>()
const reservedJobs = new Set<string>()

export function isRunning(slug: string): boolean {
  return runningJobs.has(slug) || reservedJobs.has(slug)
}

// Reserve synchronously before the route's first status write. On Vercel one
// job per process keeps two concurrent exports from sharing the 500 MB /tmp
// allowance. Local development only blocks a duplicate of the same dataset.
export function reserveJob(slug: string): boolean {
  if (isRunning(slug)) return false
  if (IS_VERCEL && runningJobs.size + reservedJobs.size > 0) return false
  reservedJobs.add(slug)
  return true
}

export function releaseJobReservation(slug: string): void {
  reservedJobs.delete(slug)
}

export function trackJob(slug: string, job: Promise<void>): void {
  reservedJobs.delete(slug)
  runningJobs.set(slug, job)
  void job.finally(() => {
    if (runningJobs.get(slug) === job) runningJobs.delete(slug)
  })
}
