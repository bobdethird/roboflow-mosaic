// Server-only admin gating for Phase 1 of shareable mosaics. Publishing is
// restricted to the admin (the share library is not yet open to all visitors);
// viewing a /m/<id> link stays fully public.
//
// "Admin" is granted two ways:
//   1. Requests from localhost — the dev machine, exactly like the /bake harness.
//      Zero-config admin for local work.
//   2. A signed admin cookie, minted by /api/mosaic/admin/unlock (the /admin
//      login page) after the admin password is entered. This is the path for a
//      deployed build, where localhost no longer applies.
//
// The admin password is stored HASHED in Supabase (admin_config.password_hash),
// so it can be set/rotated from the dashboard without a redeploy and there are
// no admin env vars. The cookie is an HMAC keyed by that hash, so rotating the
// password also invalidates existing sessions. Imports node:crypto + the share
// store, so this module is server-only (route handlers / RSC).

import { createHash, createHmac, timingSafeEqual } from "node:crypto"

import { isLocalhostHost } from "./localhost-only"
import { getAdminPasswordHash } from "./mosaic-share-store"

export const ADMIN_COOKIE = "mosaic_admin"
export const ADMIN_MAX_AGE_SECONDS = 60 * 60 * 24 * 30 // 30 days

// Must match the SQL that sets admin_config.password_hash (migration 0002):
// sha256('mosaic-admin:v1:' || password).
const PASSWORD_SALT = "mosaic-admin:v1:"

export function hashAdminPassword(plain: string): string {
  return createHash("sha256").update(`${PASSWORD_SALT}${plain}`).digest("hex")
}

// Cookie value is "<exp>.<hmac>", where the HMAC is keyed by the stored password
// hash and covers a version tag + the expiry (so the deadline can't be edited).
const TOKEN_VERSION = "mosaic-admin-unlock:v2"

function signToken(passwordHash: string, expSeconds: number): string {
  return createHmac("sha256", passwordHash)
    .update(TOKEN_VERSION)
    .update(":")
    .update(String(expSeconds))
    .digest("hex")
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

// True only if an admin password is configured and `submitted` matches it.
export async function verifyAdminPassword(submitted: string): Promise<boolean> {
  const stored = await getAdminPasswordHash()
  if (!stored) return false
  return safeEqual(hashAdminPassword(submitted), stored)
}

// Mint a fresh admin cookie value, or undefined if no password is configured.
export async function issueAdminToken(): Promise<string | undefined> {
  const stored = await getAdminPasswordHash()
  if (!stored) return undefined
  const exp = Math.floor(Date.now() / 1000) + ADMIN_MAX_AGE_SECONDS
  return `${exp}.${signToken(stored, exp)}`
}

function readCookie(cookieHeader: string | null, name: string): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

async function hasValidAdminCookie(cookieHeader: string | null): Promise<boolean> {
  const token = readCookie(cookieHeader, ADMIN_COOKIE)
  if (!token) return false
  const dot = token.indexOf(".")
  if (dot === -1) return false
  const exp = Number(token.slice(0, dot))
  if (!Number.isInteger(exp) || exp * 1000 <= Date.now()) return false
  const stored = await getAdminPasswordHash()
  if (!stored) return false
  return safeEqual(token.slice(dot + 1), signToken(stored, exp))
}

// Core check from raw header values. Used by both the Request wrapper (route
// handlers) and RSC pages (which read next/headers). Localhost is admin without
// a DB read; otherwise a missing admin cookie short-circuits to false so the
// anonymous common case never touches the database.
export async function isAdminContext(
  host: string | null,
  cookieHeader: string | null
): Promise<boolean> {
  if (isLocalhostHost(host)) return true
  if (!cookieHeader || !cookieHeader.includes(`${ADMIN_COOKIE}=`)) return false
  return hasValidAdminCookie(cookieHeader)
}

export async function isAdminRequest(request: Request): Promise<boolean> {
  return isAdminContext(
    request.headers.get("host"),
    request.headers.get("cookie")
  )
}
