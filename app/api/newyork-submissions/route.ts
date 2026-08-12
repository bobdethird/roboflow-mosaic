import {
  ALLOWED_CONTENT_TYPES,
  authorizeSubmission,
  countRecentByIp,
  hashIp,
  MAX_CREDIT_NAME_LENGTH,
  MAX_FILES_PER_SUBMISSION,
  MAX_IMAGE_BYTES,
  RATE_LIMIT_PER_HOUR,
  SubmissionsCapExceededError,
  SubmissionsStoreNotConfiguredError,
  type SubmissionFileMeta,
} from "@/lib/new-york-submissions-store"

// Authorize a "Mosaic of New York" photo submission. The browser posts only
// lightweight JSON metadata (content types + sizes + optional credit name); this
// function rate-limits it, mints a signed upload URL per photo, and inserts the
// pending rows. The actual image bytes are then PUT straight to Supabase Storage
// from the client — they never pass through here, so Vercel's 4.5 MB function
// body limit can't reject big phone photos. Validated + rate-limited because this
// is the public write surface: a per-IP hourly cap (in photos) and a global cap.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for")
  if (fwd) return fwd.split(",")[0]!.trim()
  return request.headers.get("x-real-ip")?.trim() || "unknown"
}

const ALLOWED = new Set<string>(ALLOWED_CONTENT_TYPES)
const MAX_FILENAME_LENGTH = 256

type IncomingFile = { contentType: string; size: number; name?: unknown }

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 })
  }

  const rawFiles = (body as { files?: unknown })?.files
  if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
    return Response.json({ error: "Add at least one photo." }, { status: 400 })
  }
  if (rawFiles.length > MAX_FILES_PER_SUBMISSION) {
    return Response.json(
      { error: `You can upload at most ${MAX_FILES_PER_SUBMISSION} photos.` },
      { status: 400 }
    )
  }

  const files: SubmissionFileMeta[] = []
  for (const raw of rawFiles as IncomingFile[]) {
    const contentType = raw?.contentType
    const size = raw?.size
    if (typeof contentType !== "string" || !ALLOWED.has(contentType)) {
      return Response.json(
        { error: "Only JPEG, PNG, WebP, GIF, or HEIC images are allowed." },
        { status: 415 }
      )
    }
    if (typeof size !== "number" || !Number.isFinite(size) || size <= 0) {
      return Response.json({ error: "Invalid photo." }, { status: 400 })
    }
    if (size > MAX_IMAGE_BYTES) {
      return Response.json(
        {
          error: `Each photo must be ${
            MAX_IMAGE_BYTES / (1024 * 1024)
          } MB or smaller.`,
        },
        { status: 413 }
      )
    }
    const name = typeof raw?.name === "string" ? raw.name.slice(0, MAX_FILENAME_LENGTH) : null
    files.push({ contentType, size, originalFilename: name })
  }

  // Credit: opt-in. A blank/absent name means "don't credit me".
  const rawName = (body as { creditName?: unknown })?.creditName
  let creditName: string | null = null
  if (typeof rawName === "string") {
    const trimmed = rawName.trim()
    if (trimmed.length > MAX_CREDIT_NAME_LENGTH) {
      return Response.json({ error: "That name is too long." }, { status: 400 })
    }
    creditName = trimmed || null
  }

  const ipHash = hashIp(clientIp(request))

  try {
    // Per-IP hourly cap, counted in photos. Reject the whole submission if it
    // would push this IP over the limit.
    const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const recent = await countRecentByIp(ipHash, sinceIso)
    if (recent + files.length > RATE_LIMIT_PER_HOUR) {
      return Response.json(
        {
          error:
            "You've reached the upload limit for now. Please try again in an hour.",
        },
        { status: 429 }
      )
    }

    const { batchId, uploads } = await authorizeSubmission({
      files,
      creditName,
      ipHash,
    })
    return Response.json({ ok: true, batchId, uploads })
  } catch (err) {
    if (err instanceof SubmissionsCapExceededError) {
      return Response.json(
        {
          error:
            "We're getting a lot of uploads right now — please try again shortly.",
        },
        { status: 503 }
      )
    }
    if (err instanceof SubmissionsStoreNotConfiguredError) {
      return Response.json(
        { error: "Uploads aren't configured on this deployment." },
        { status: 503 }
      )
    }
    return Response.json(
      { error: "Failed to start your upload." },
      { status: 500 }
    )
  }
}
