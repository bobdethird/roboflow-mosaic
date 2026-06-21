// Server-only persistence for shareable mosaics. Talks to Supabase Storage and
// PostgREST directly with the service key over fetch — the same approach the
// /api/mosaic proxy uses, so this adds no new dependency and the secret key
// never leaves the server. Importing node:crypto keeps it off the client bundle.

import { createHash, randomBytes } from "node:crypto"

import { SUPABASE_URL } from "./photo-library"
import type { GalleryTile } from "./gallery"

// Private bucket holding the published composites + hit-maps (see migration).
const SHARED_BUCKET =
  process.env.MOSAIC_SHARED_BUCKET?.trim() || "mosaics-shared"
const REST_BASE = `${SUPABASE_URL}/rest/v1`
const STORAGE_BASE = `${SUPABASE_URL}/storage/v1`

// Limits enforced at the write boundary (anonymous-ish public writes are the
// only new abuse surface).
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024 // 6 MB
export const MAX_TILEMAP_BYTES = 4 * 1024 * 1024 // 4 MB
// Per-tile zoom geometry (base64 typed buffers + tile urls); larger than the
// coarse hit-map since it carries every cell, but still small.
export const MAX_GEOMETRY_BYTES = 8 * 1024 * 1024 // 8 MB
export const MAX_DIMENSION = 4096
export const RATE_LIMIT_PER_HOUR = 30

export type MosaicRow = {
  id: string
  created_at: string
  collection: string
  w: number
  h: number
  image_path: string
  tilemap_path: string
  // Per-tile zoom geometry object path; null for mosaics published before the
  // zoom feature (they still view + hover, just without the zoom overlay).
  geometry_path: string | null
  content_hash: string
  ip_hash: string | null
  deleted: boolean
}

// The hit-map shape persisted as tilemap.json (matches lib/gallery GalleryTileMap).
export type StoredTileMap = {
  w: number
  h: number
  cols: number
  rows: number
  grid: number[]
  tiles: GalleryTile[]
}

export class ShareStoreNotConfiguredError extends Error {}

function adminKey(): string {
  const key =
    process.env.SUPABASE_SECRET_KEY?.trim() ||
    process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!key) {
    throw new ShareStoreNotConfiguredError(
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

// ─── ids + hashing ────────────────────────────────────────────────────────────

// URL-safe, unambiguous-enough slug. 8 chars over a 62-char alphabet ≈ 2.18e14
// space — effectively unguessable for a share link, and collisions are retried
// on insert anyway. (A small modulo bias is irrelevant for opaque ids.)
const ID_ALPHABET =
  "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"

export function generateId(length = 8): string {
  const bytes = randomBytes(length)
  let out = ""
  for (let i = 0; i < length; i++)
    out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length]
  return out
}

export function hashImage(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

export function hashIp(ip: string): string {
  const salt = process.env.MOSAIC_SHARE_SALT?.trim() || "mosaic-share:v1"
  return createHash("sha256").update(salt).update(":").update(ip).digest("hex")
}

// ─── storage ─────────────────────────────────────────────────────────────────

async function uploadObject(
  path: string,
  body: Uint8Array | string,
  contentType: string
): Promise<void> {
  const key = adminKey()
  const res = await fetch(
    `${STORAGE_BASE}/object/${SHARED_BUCKET}/${encodeStoragePath(path)}`,
    {
      method: "POST",
      headers: {
        ...authHeaders(key),
        "content-type": contentType,
        // Re-share of an identical composite reuses the same id/path; allow the
        // write to land idempotently rather than 409 on a repeat.
        "x-upsert": "true",
      },
      body: typeof body === "string" ? body : new Uint8Array(body),
    }
  )
  if (!res.ok) {
    throw new Error(
      `storage upload failed (${res.status}): ${await res.text()}`
    )
  }
}

// Streams an object straight from the private bucket. The public /m/[id]/image
// and /m/[id]/tilemap routes call this AFTER confirming the row exists and isn't
// deleted, so they can serve cross-origin (for unfurl) without exposing the
// bucket itself.
export function fetchObject(
  path: string,
  range?: string | null
): Promise<Response> {
  const key = adminKey()
  const headers = new Headers(authHeaders(key))
  if (range) headers.set("range", range)
  return fetch(
    `${STORAGE_BASE}/object/${SHARED_BUCKET}/${encodeStoragePath(path)}`,
    { headers }
  )
}

export function imagePathFor(id: string): string {
  return `shared/${id}/image.jpg`
}
export function tilemapPathFor(id: string): string {
  return `shared/${id}/tilemap.json`
}
export function geometryPathFor(id: string): string {
  return `shared/${id}/geometry.json`
}

// ─── table (PostgREST) ───────────────────────────────────────────────────────

// Hashed admin password (admin_config.password_hash), or null if not configured
// / unreachable. Fails closed: any error reads as "no admin configured" so the
// publish gate stays shut rather than throwing on a page render.
export async function getAdminPasswordHash(): Promise<string | null> {
  try {
    const key = adminKey()
    const res = await fetch(
      `${REST_BASE}/admin_config?id=eq.admin&select=password_hash&limit=1`,
      { headers: authHeaders(key) }
    )
    if (!res.ok) return null
    const rows = (await res.json()) as { password_hash?: string }[]
    return rows[0]?.password_hash ?? null
  } catch {
    return null
  }
}

export async function getMosaic(id: string): Promise<MosaicRow | null> {
  const key = adminKey()
  const res = await fetch(
    `${REST_BASE}/mosaics?id=eq.${encodeURIComponent(id)}` +
      `&deleted=is.false&select=*&limit=1`,
    { headers: authHeaders(key) }
  )
  if (!res.ok) return null
  const rows = (await res.json()) as MosaicRow[]
  return rows[0] ?? null
}

export async function findLiveByContentHash(
  contentHash: string
): Promise<MosaicRow | null> {
  const key = adminKey()
  const res = await fetch(
    `${REST_BASE}/mosaics?content_hash=eq.${encodeURIComponent(contentHash)}` +
      `&deleted=is.false&select=*&limit=1`,
    { headers: authHeaders(key) }
  )
  if (!res.ok) return null
  const rows = (await res.json()) as MosaicRow[]
  return rows[0] ?? null
}

// Count of live rows from this ip_hash within the window — the rate-limit scan.
export async function countRecentByIp(
  ipHash: string,
  sinceIso: string
): Promise<number> {
  const key = adminKey()
  const res = await fetch(
    `${REST_BASE}/mosaics?ip_hash=eq.${encodeURIComponent(ipHash)}` +
      `&created_at=gte.${encodeURIComponent(sinceIso)}&select=id`,
    {
      headers: {
        ...authHeaders(key),
        prefer: "count=exact",
        // Ask for a single row; the total comes back in content-range.
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

export type InsertResult =
  | { ok: true }
  | { ok: false; conflict: boolean; status: number; detail: string }

export async function insertMosaic(row: {
  id: string
  collection: string
  w: number
  h: number
  image_path: string
  tilemap_path: string
  geometry_path: string | null
  content_hash: string
  ip_hash: string | null
}): Promise<InsertResult> {
  const key = adminKey()
  const res = await fetch(`${REST_BASE}/mosaics`, {
    method: "POST",
    headers: {
      ...authHeaders(key),
      "content-type": "application/json",
      prefer: "return=minimal",
    },
    body: JSON.stringify(row),
  })
  if (res.ok) return { ok: true }
  const detail = await res.text()
  return { ok: false, conflict: res.status === 409, status: res.status, detail }
}

// ─── orchestration ───────────────────────────────────────────────────────────

export type PublishInput = {
  collection: string
  w: number
  h: number
  imageBytes: Uint8Array
  tilemap: StoredTileMap
  // Validated, canonical encoded geometry JSON string (or null when the client
  // didn't send it — older clients, or a build without the zoom feature).
  geometryJson: string | null
  ipHash: string | null
}

// Persists one published mosaic and returns its id. Idempotent: an identical
// composite (same content hash) returns the existing live id without writing a
// duplicate. Throws ShareStoreNotConfiguredError if Supabase isn't wired up.
export async function publishMosaic(
  input: PublishInput
): Promise<{ id: string; reused: boolean }> {
  const contentHash = hashImage(input.imageBytes)

  const existing = await findLiveByContentHash(contentHash)
  if (existing) return { id: existing.id, reused: true }

  const tilemapJson = JSON.stringify(input.tilemap)

  // Retry only id collisions; a content-hash collision means a concurrent
  // publish of the same image won the race, so return that row instead.
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = generateId()
    const imagePath = imagePathFor(id)
    const tilemapPath = tilemapPathFor(id)
    const geometryPath = input.geometryJson ? geometryPathFor(id) : null

    await uploadObject(imagePath, input.imageBytes, "image/jpeg")
    await uploadObject(tilemapPath, tilemapJson, "application/json")
    if (geometryPath) {
      await uploadObject(geometryPath, input.geometryJson!, "application/json")
    }

    const result = await insertMosaic({
      id,
      collection: input.collection,
      w: input.w,
      h: input.h,
      image_path: imagePath,
      tilemap_path: tilemapPath,
      geometry_path: geometryPath,
      content_hash: contentHash,
      ip_hash: input.ipHash,
    })

    if (result.ok) return { id, reused: false }

    if (result.conflict) {
      const raced = await findLiveByContentHash(contentHash)
      if (raced) return { id: raced.id, reused: true }
      // Otherwise it was an id collision — loop and mint a new one.
      continue
    }

    throw new Error(`insert failed (${result.status}): ${result.detail}`)
  }

  throw new Error("could not allocate a unique mosaic id")
}
