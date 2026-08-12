// Server-side store for ingested Roboflow datasets.
//
// Each dataset version gets one directory under the cache root, laid out like a
// Supabase mosaic bucket so the browser engine can consume it unchanged:
//
//   <cache>/<slug>/manifest.json           { version, photos: [{ id, w, h }] }
//   <cache>/<slug>/signatures-coarse.bin   uint16 LE coarse signatures, in photo order
//   <cache>/<slug>/thumbs/<id>.jpg         one thumbnail per photo
//   <cache>/<slug>/reference.jpg           the dataset's median image
//   <cache>/<slug>/status.json             ingest progress / result
//
// Ingests are long-running, so the route starts one in the background and the
// page polls status.json. `runningJobs` keeps a single process from starting the
// same ingest twice.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

import type { IngestStatus, RoboflowDataset } from "./roboflow"
import { isDatasetSlug } from "./roboflow"

export const CACHE_ROOT = path.resolve(
  process.env.ROBOFLOW_CACHE_DIR?.trim() ||
    path.join(process.cwd(), ".roboflow-cache")
)

export function datasetDir(slug: string): string {
  if (!isDatasetSlug(slug)) throw new Error(`Invalid dataset slug: ${slug}`)
  return path.join(CACHE_ROOT, slug)
}

// Resolve a request path inside a dataset directory, refusing anything that
// escapes it (the asset route passes user-controlled segments).
export function datasetFile(slug: string, relativePath: string): string | null {
  const base = datasetDir(slug)
  const resolved = path.resolve(base, relativePath)
  const prefix = base + path.sep
  return resolved === base || resolved.startsWith(prefix) ? resolved : null
}

export function statusPath(slug: string): string {
  return path.join(datasetDir(slug), "status.json")
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

// Build a reporter that persists coarse progress, throttled so a per-image
// callback doesn't turn into thousands of writes.
export function progressWriter(
  slug: string,
  onError: (error: unknown) => void = () => {}
): {
  report: ProgressReporter
  finish: (
    state: "ready" | "error",
    extra: { dataset?: RoboflowDataset; error?: string }
  ) => Promise<void>
} {
  let lastWrite = 0
  let lastStep = ""

  const report: ProgressReporter = (step, done = 0, total = 0) => {
    const now = Date.now()
    // Persist a stage change immediately; rate-limit the counter updates within
    // a stage so a per-image callback doesn't hammer the disk.
    if (step === lastStep && now - lastWrite < 400) return
    lastStep = step
    lastWrite = now
    void writeStatus({
      slug,
      state: "running",
      step,
      done,
      total,
      updatedAt: new Date().toISOString(),
    }).catch(onError)
  }

  const finish = async (
    state: "ready" | "error",
    extra: { dataset?: RoboflowDataset; error?: string }
  ) => {
    await writeStatus({
      slug,
      state,
      step: state === "ready" ? "Ready" : "Failed",
      done: 0,
      total: 0,
      updatedAt: new Date().toISOString(),
      ...extra,
    })
  }

  return { report, finish }
}

// Slugs whose ingest is running in this process.
const runningJobs = new Map<string, Promise<void>>()

export function isRunning(slug: string): boolean {
  return runningJobs.has(slug)
}

export function trackJob(slug: string, job: Promise<void>): void {
  runningJobs.set(slug, job)
  void job.finally(() => {
    if (runningJobs.get(slug) === job) runningJobs.delete(slug)
  })
}
