// Distributed ingest coordination backed by Vercel Blob.
//
// Function instances do not share memory, so the in-process job map cannot
// prevent two instances from exporting the same dataset. Conditional Blob
// writes give us a small compare-and-swap control plane without another data
// service: expiring per-dataset leases and one rate record per hashed client.

import {
  BlobPreconditionFailedError,
  del,
  head,
  put,
  type HeadBlobResult,
} from "@vercel/blob"
import { createHash, randomUUID } from "node:crypto"

const CONTROL_PREFIX = "roboflow-control"
const CONTROL_CACHE_SECONDS = 60
const LEASE_MS = 6 * 60 * 1000
const RATE_WINDOW_MS = 15 * 60 * 1000
const RATE_LIMIT = 4
const GLOBAL_RATE_LIMIT = 20
const CAS_RETRIES = 4

type ControlRecord<T> = {
  meta: HeadBlobResult
  value: T
}

export type IngestLease = {
  pathname: string
  owner: string
  etag: string
}

export type RateLimitResult = {
  allowed: boolean
  limit: number
  remaining: number
  retryAfterSeconds: number
}

export const INGEST_RATE_LIMIT = RATE_LIMIT
export const INGEST_RATE_WINDOW_MS = RATE_WINDOW_MS
export const GLOBAL_INGEST_RATE_LIMIT = GLOBAL_RATE_LIMIT

type LeaseRecord = {
  owner: string
  expiresAt: number
}

type RateRecord = {
  count: number
  resetAt: number
}

function versionedUrl(meta: HeadBlobResult): URL {
  const url = new URL(meta.url)
  url.searchParams.set("v", meta.etag)
  return url
}

async function readControl<T>(
  pathname: string
): Promise<ControlRecord<T> | null> {
  try {
    const meta = await head(pathname)
    const response = await fetch(versionedUrl(meta), { cache: "no-store" })
    if (!response.ok) return null
    return { meta, value: (await response.json()) as T }
  } catch {
    return null
  }
}

function putControl<T>(
  pathname: string,
  value: T,
  options: { allowOverwrite: boolean; ifMatch?: string }
) {
  return put(pathname, JSON.stringify(value), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: options.allowOverwrite,
    ifMatch: options.ifMatch,
    contentType: "application/json",
    cacheControlMaxAge: CONTROL_CACHE_SECONDS,
  })
}

function lockPath(slug: string): string {
  return `${CONTROL_PREFIX}/locks/${slug}.json`
}

export async function acquireIngestLease(
  slug: string,
  now = Date.now()
): Promise<IngestLease | null> {
  const pathname = lockPath(slug)
  const value: LeaseRecord = {
    owner: randomUUID(),
    expiresAt: now + LEASE_MS,
  }

  try {
    const created = await putControl(pathname, value, { allowOverwrite: false })
    return { pathname, owner: value.owner, etag: created.etag }
  } catch (createError) {
    const current = await readControl<LeaseRecord>(pathname)
    if (!current) throw createError
    if (current.value.expiresAt > now) return null

    // The previous function died without releasing its lease. Replace it only
    // if nobody else changed the record after our read.
    try {
      const replaced = await putControl(pathname, value, {
        allowOverwrite: true,
        ifMatch: current.meta.etag,
      })
      return { pathname, owner: value.owner, etag: replaced.etag }
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) return null
      throw error
    }
  }
}

// Is some instance still holding this dataset's lease? A job holds one until it
// settles, so this answers "is an ingest alive" without asking an instance that
// would only know about its own. The age of a status record cannot answer it:
// the record is written by the ingesting instance and read by another, and a
// write that never landed looks exactly like a worker that died.
export async function ingestLeaseHeld(
  slug: string,
  now = Date.now()
): Promise<boolean> {
  const current = await readControl<LeaseRecord>(lockPath(slug))
  return Boolean(current && current.value.expiresAt > now)
}

export async function releaseIngestLease(lease: IngestLease): Promise<void> {
  try {
    await del(lease.pathname, { ifMatch: lease.etag })
  } catch (error) {
    // An expired lease may already have been replaced. Never delete the newer
    // owner's record, and do not turn a completed ingest into an error.
    if (!(error instanceof BlobPreconditionFailedError)) throw error
  }
}

function ratePath(clientAddress: string): string {
  const digest = createHash("sha256")
    .update(`roboflow-ingest\0${clientAddress}`)
    .digest("hex")
  return `${CONTROL_PREFIX}/rate/${digest}.json`
}

function rateResult(
  record: RateRecord,
  now: number,
  limit: number
): RateLimitResult {
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((record.resetAt - now) / 1000)
  )
  return {
    allowed: record.count <= limit,
    limit,
    remaining: Math.max(0, limit - record.count),
    retryAfterSeconds,
  }
}

// Pure transition used by the Blob CAS loop and regression tests.
export function nextRateRecord(
  current: RateRecord | null,
  now: number,
  limit = RATE_LIMIT,
  windowMs = RATE_WINDOW_MS
): { record: RateRecord; result: RateLimitResult } {
  if (current && current.resetAt > now && current.count >= limit) {
    return {
      record: current,
      result: { ...rateResult(current, now, limit), allowed: false },
    }
  }
  const record: RateRecord =
    !current || current.resetAt <= now
      ? { count: 1, resetAt: now + windowMs }
      : { ...current, count: current.count + 1 }
  return { record, result: rateResult(record, now, limit) }
}

async function consumeRateLimit(
  pathname: string,
  now: number,
  limit: number,
  windowMs: number
): Promise<RateLimitResult> {
  for (let attempt = 0; attempt < CAS_RETRIES; attempt++) {
    const current = await readControl<RateRecord>(pathname)
    if (!current) {
      const { record: first, result } = nextRateRecord(
        null,
        now,
        limit,
        windowMs
      )
      try {
        await putControl(pathname, first, { allowOverwrite: false })
        return result
      } catch {
        // Another instance created it between read and write; retry the CAS.
        continue
      }
    }

    const { record: next, result } = nextRateRecord(
      current.value,
      now,
      limit,
      windowMs
    )
    if (!result.allowed) return result
    try {
      await putControl(pathname, next, {
        allowOverwrite: true,
        ifMatch: current.meta.etag,
      })
      return result
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError) continue
      throw error
    }
  }

  // Heavy contention is treated as a short throttle, not an uncoordinated
  // ingest. The client can retry without starting duplicate work.
  return {
    allowed: false,
    limit,
    remaining: 0,
    retryAfterSeconds: 5,
  }
}

export function consumeIngestRateLimit(
  clientAddress: string,
  now = Date.now()
): Promise<RateLimitResult> {
  return consumeRateLimit(
    ratePath(clientAddress),
    now,
    RATE_LIMIT,
    RATE_WINDOW_MS
  )
}

export function consumeGlobalIngestRateLimit(
  now = Date.now()
): Promise<RateLimitResult> {
  return consumeRateLimit(
    `${CONTROL_PREFIX}/rate/global.json`,
    now,
    GLOBAL_RATE_LIMIT,
    RATE_WINDOW_MS
  )
}
