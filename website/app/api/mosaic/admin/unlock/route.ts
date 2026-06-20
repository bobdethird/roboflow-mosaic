import {
  ADMIN_COOKIE,
  ADMIN_MAX_AGE_SECONDS,
  issueAdminToken,
  verifyAdminPassword,
} from "@/lib/mosaic-admin"

// Logs the admin in: verifies the submitted password against the hash in
// Supabase (admin_config) and, on success, sets the signed admin cookie. Driven
// by the /admin page. Localhost is already admin without this.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  let password: unknown
  try {
    password = (await request.json())?.password
  } catch {
    return new Response("Invalid JSON", { status: 400 })
  }
  if (typeof password !== "string") {
    return new Response("Missing password", { status: 400 })
  }

  if (!(await verifyAdminPassword(password))) {
    // Same response whether the password is wrong or no admin is configured, so
    // we don't leak which.
    return new Response("Incorrect password", { status: 401 })
  }

  const token = await issueAdminToken()
  if (!token) {
    return new Response("Admin login is not configured.", { status: 503 })
  }

  const secure = new URL(request.url).protocol === "https:"
  const cookie =
    `${ADMIN_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; ` +
    `SameSite=Lax; Max-Age=${ADMIN_MAX_AGE_SECONDS}` +
    (secure ? "; Secure" : "")

  const res = Response.json({ ok: true })
  res.headers.append("set-cookie", cookie)
  return res
}
