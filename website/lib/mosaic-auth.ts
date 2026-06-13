// Server-only auth helpers for the gated "personal" mosaic collection.
//
// The personal bucket is locked behind a single password held in the
// MOSAIC_PERSONAL_PASSWORD env var (server-only — never shipped to the browser).
// `/api/mosaic/unlock` checks a submitted password against it and, on success,
// sets an httpOnly cookie carrying an HMAC token signed with
// MOSAIC_UNLOCK_SECRET. The `/api/mosaic` proxy then requires that cookie before
// serving any object from the gated bucket, so the photos genuinely can't be
// loaded without knowing the password.
//
// This module imports `node:crypto`, so it must only be used from server code
// (route handlers running under `runtime = "nodejs"`).

import { createHmac, timingSafeEqual } from "node:crypto"

// httpOnly cookie that proves the visitor unlocked the personal collection.
export const PERSONAL_UNLOCK_COOKIE = "mosaic_personal"

// How long an unlock lasts before the visitor must re-enter the password.
export const UNLOCK_MAX_AGE_SECONDS = 60 * 60 * 24 * 30 // 30 days

// The configured personal-collection password, or undefined if unset (in which
// case the collection stays locked — it "fails closed").
export function personalPassword(): string | undefined {
  return process.env.MOSAIC_PERSONAL_PASSWORD?.trim() || undefined
}

// Separate signing secret for unlock cookies. Keeping this independent from the
// password prevents a leaked cookie token from becoming an offline password oracle.
export function unlockSecret(): string | undefined {
  return process.env.MOSAIC_UNLOCK_SECRET?.trim() || undefined
}

export function isPersonalUnlockConfigured(): boolean {
  return personalPassword() !== undefined && unlockSecret() !== undefined
}

// Cookie value: "<expiry-unix-seconds>.<hmac>". The signature covers the password
// (so rotating MOSAIC_PERSONAL_PASSWORD invalidates old unlocks) and the expiry
// (so the deadline can't be extended by editing the cookie). The HMAC key is the
// separate unlock secret, never the password itself.
const TOKEN_VERSION = "mosaic-personal-unlock:v3"

function signUnlock(
  password: string,
  secret: string,
  expSeconds: number
): string {
  return createHmac("sha256", secret)
    .update(TOKEN_VERSION)
    .update(":")
    .update(String(password.length))
    .update(":")
    .update(password)
    .update(":")
    .update(String(expSeconds))
    .digest("hex")
}

// Mint a fresh unlock cookie value that expires UNLOCK_MAX_AGE_SECONDS from now.
export function issueUnlockToken(): string | undefined {
  const password = personalPassword()
  const secret = unlockSecret()
  if (!password || !secret) return undefined
  const exp = Math.floor(Date.now() / 1000) + UNLOCK_MAX_AGE_SECONDS
  return `${exp}.${signUnlock(password, secret, exp)}`
}

// Constant-time string compare that never throws on length mismatch.
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function verifyPassword(submitted: string): boolean {
  const password = personalPassword()
  if (!password) return false
  return safeEqual(submitted, password)
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie")
  if (!header) return undefined
  for (const part of header.split(";")) {
    const eq = part.indexOf("=")
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== name) continue
    return decodeURIComponent(part.slice(eq + 1).trim())
  }
  return undefined
}

// Whether the request carries a valid, unexpired unlock cookie for the personal
// collection. The expiry is enforced here (not just via the cookie's maxAge), so a
// copied/exfiltrated cookie also stops working once its signed deadline passes.
export function hasValidUnlock(request: Request): boolean {
  const password = personalPassword()
  const secret = unlockSecret()
  if (!password || !secret) return false
  const token = readCookie(request, PERSONAL_UNLOCK_COOKIE)
  if (!token) return false
  const dot = token.indexOf(".")
  if (dot === -1) return false
  const exp = Number(token.slice(0, dot))
  if (!Number.isInteger(exp) || exp * 1000 <= Date.now()) return false
  return safeEqual(token.slice(dot + 1), signUnlock(password, secret, exp))
}
