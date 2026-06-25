// Server-only persistence for "A Mosaic of New York" photo submissions. Mirrors
// lib/mosaic-share-store.ts: it talks to Supabase Storage + PostgREST directly
// with the service key over fetch, so the secret never leaves the server and no
// new dependency is added. node:crypto keeps it off the client bundle.

import { createHash, randomBytes, randomUUID } from "node:crypto"

import { SUPABASE_URL } from "./photo-library"

// Private bucket holding the raw submitted photos (pending review). Overridable
// so it can be pointed elsewhere without a redeploy.
const SUBMISSIONS_BUCKET =
  process.env.NEWYORK_SUBMISSIONS_BUCKET?.trim() || "newyork-submissions"
const REST_BASE = `${SUPABASE_URL}/rest/v1`
const STORAGE_BASE = `${SUPABASE_URL}/storage/v1`

// ─── limits ──────────────────────────────────────────────────────────────────

// Up to five photos per submission (the question is "maximum 5").
export const MAX_FILES_PER_SUBMISSION = 5
// The `newyork-submissions` bucket is configured with a 10 MB per-object cap;
// match it here so we reject early with a clear message instead of a storage 413.
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024
// Free-text credit name is a person's name, not an essay.
export const MAX_CREDIT_NAME_LENGTH = 120
// Accepted image types. Phones commonly produce HEIC/HEIF, so allow them too.
export const ALLOWED_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif",
] as const

// Per-IP hourly cap, counted in *photos* (rows): a cheap first line so one
// network can't flood the review queue or the bucket. Five matches one full
// submission per hour. Overridable via env for tuning without a redeploy.
export const RATE_LIMIT_PER_HOUR = (() => {
  const raw = Number(process.env.NEWYORK_SUBMISSIONS_RATE_LIMIT)
  return Number.isInteger(raw) && raw > 0 ? raw : 5
})()
// Global hourly cap on new photos across all submitters — the real storage /
// queue guardrail that bounds how much can be minted per hour regardless of IP.
export const GLOBAL_RATE_LIMIT_PER_HOUR = (() => {
  const raw = Number(process.env.NEWYORK_SUBMISSIONS_GLOBAL_RATE_LIMIT)
  return Number.isInteger(raw) && raw > 0 ? raw : 300
})()

export class SubmissionsStoreNotConfiguredError extends Error {}
// Thrown when the global hourly cap is reached; the route maps it to a 503 so
// the client shows a soft "high demand, try again shortly" notice.
export class SubmissionsCapExceededError extends Error {}

function adminKey(): string {
  const key =
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!key) {
    throw new SubmissionsStoreNotConfiguredError(
      "SUPABASE_SECRET_KEY is not configured."
    )
  }
  return key
}

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, authorization: `Bearer ${key}` }
}

function encodeStoragePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
}

// ─── hashing / ids ─────────────────────────────────────────────────────────────

// Reuse the same salted-IP scheme as the share store so the two surfaces hash
// identically; the raw IP is never stored.
export function hashIp(ip: string): string {
  const salt = process.env.MOSAIC_SHARE_SALT?.trim() || "mosaic-share:v1"
  return createHash("sha256").update(salt).update(":").update(ip).digest("hex")
}

export function newBatchId(): string {
  return randomUUID()
}

// Opaque, collision-resistant per-object name (the row id is a separate uuid).
function randomObjectName(): string {
  return randomBytes(12).toString("hex")
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif",
}

export function storagePathFor(batchId: string, contentType: string): string {
  const ext = EXT_BY_TYPE[contentType] ?? "bin"
  return `submissions/${batchId}/${randomObjectName()}.${ext}`
}

// ─── storage ─────────────────────────────────────────────────────────────────

// Mints a one-time signed upload URL for `path`. The browser PUTs the file bytes
// straight to this URL, so the photo never passes through our serverless function
// (Vercel caps function request bodies at 4.5 MB; phone photos blow past that).
// The token in the URL authorizes the write; the bucket's own size/type limits
// still apply. Returns the absolute URL the client uploads to.
async function createSignedUploadUrl(path: string): Promise<string> {
  const key = adminKey()
  const res = await fetch(
    `${STORAGE_BASE}/object/upload/sign/${SUBMISSIONS_BUCKET}/${encodeStoragePath(
      path
    )}`,
    {
      method: "POST",
      headers: { ...authHeaders(key), "content-type": "application/json" },
      body: "{}",
    }
  )
  if (!res.ok) {
    throw new Error(`sign upload failed (${res.status}): ${await res.text()}`)
  }
  const data = (await res.json()) as { url?: string }
  if (!data.url) throw new Error("sign upload returned no url")
  // data.url is storage-relative (e.g. "/object/upload/sign/<bucket>/<path>?token=…").
  const suffix = data.url.startsWith("/") ? data.url : `/${data.url}`
  return `${STORAGE_BASE}${suffix}`
}

// ─── table (PostgREST) ───────────────────────────────────────────────────────

// Count rows (photos) from this ip_hash within the window — the per-IP scan.
export async function countRecentByIp(
  ipHash: string,
  sinceIso: string
): Promise<number> {
  const key = adminKey()
  const res = await fetch(
    `${REST_BASE}/newyork_submissions?ip_hash=eq.${encodeURIComponent(ipHash)}` +
      `&submitted_at=gte.${encodeURIComponent(sinceIso)}&select=id`,
    {
      headers: {
        ...authHeaders(key),
        prefer: "count=exact",
        range: "0-0",
      },
    }
  )
  if (!res.ok) return 0
  const range = res.headers.get("content-range") // e.g. "0-0/12" or "*/0"
  const total = range?.split("/")[1]
  const n = total ? Number(total) : NaN
  return Number.isFinite(n) ? n : 0
}

// Count all rows within the window — the global capacity scan. Fails CLOSED: an
// unreadable count reports "full" so a Supabase hiccup can't bypass the cap.
export async function countRecentTotal(sinceIso: string): Promise<number> {
  const key = adminKey()
  const res = await fetch(
    `${REST_BASE}/newyork_submissions?submitted_at=gte.${encodeURIComponent(
      sinceIso
    )}&select=id`,
    {
      headers: {
        ...authHeaders(key),
        prefer: "count=exact",
        range: "0-0",
      },
    }
  )
  if (!res.ok) return GLOBAL_RATE_LIMIT_PER_HOUR
  const range = res.headers.get("content-range")
  const total = range?.split("/")[1]
  const n = total ? Number(total) : NaN
  return Number.isFinite(n) ? n : GLOBAL_RATE_LIMIT_PER_HOUR
}

export type SubmissionRow = {
  storage_path: string
  original_filename: string | null
  file_size: number
  content_type: string
  credit_name: string | null
  batch_id: string
  ip_hash: string | null
}

// Bulk-insert the photo rows for one submission. Returns false on any non-OK
// response (the route maps that to a 500). return=minimal keeps the body empty.
async function insertSubmissions(rows: SubmissionRow[]): Promise<boolean> {
  const key = adminKey()
  const res = await fetch(`${REST_BASE}/newyork_submissions`, {
    method: "POST",
    headers: {
      ...authHeaders(key),
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  })
  return res.ok
}

// ─── orchestration ───────────────────────────────────────────────────────────

// One photo's metadata (the bytes go direct to Storage, not through here).
export type SubmissionFileMeta = {
  contentType: string
  size: number
  originalFilename: string | null
}

export type AuthorizeInput = {
  files: SubmissionFileMeta[]
  creditName: string | null
  ipHash: string | null
}

// What the client needs to upload one file: where to PUT it.
export type AuthorizedUpload = {
  path: string
  uploadUrl: string
  contentType: string
}

// Reserves a submission: enforces the global hourly cap, mints a signed upload
// URL per photo, and inserts the matching `pending` rows (all sharing a
// batch_id). The browser then PUTs each file straight to its uploadUrl. Rows are
// written up front so the rate-limit budget is consumed immediately; if a client
// abandons the upload, the row simply points at a never-written object (the
// review queue can skip it). The per-IP cap is checked in the route, before this.
export async function authorizeSubmission(
  input: AuthorizeInput
): Promise<{ batchId: string; uploads: AuthorizedUpload[] }> {
  const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const recentTotal = await countRecentTotal(sinceIso)
  if (recentTotal + input.files.length > GLOBAL_RATE_LIMIT_PER_HOUR) {
    throw new SubmissionsCapExceededError("Global submission capacity reached.")
  }

  const batchId = newBatchId()
  const uploads: AuthorizedUpload[] = []
  const rows: SubmissionRow[] = []

  for (const file of input.files) {
    const storagePath = storagePathFor(batchId, file.contentType)
    const uploadUrl = await createSignedUploadUrl(storagePath)
    uploads.push({ path: storagePath, uploadUrl, contentType: file.contentType })
    rows.push({
      storage_path: storagePath,
      original_filename: file.originalFilename,
      file_size: file.size,
      content_type: file.contentType,
      credit_name: input.creditName,
      batch_id: batchId,
      ip_hash: input.ipHash,
    })
  }

  const ok = await insertSubmissions(rows)
  if (!ok) throw new Error("failed to insert submission rows")

  return { batchId, uploads }
}
