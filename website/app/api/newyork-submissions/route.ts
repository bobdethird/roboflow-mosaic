import {
  ALLOWED_CONTENT_TYPES,
  countRecentByIp,
  hashIp,
  MAX_CREDIT_NAME_LENGTH,
  MAX_FILES_PER_SUBMISSION,
  MAX_IMAGE_BYTES,
  RATE_LIMIT_PER_HOUR,
  submitPhotos,
  SubmissionsCapExceededError,
  SubmissionsStoreNotConfiguredError,
  type SubmissionPhoto,
} from "@/lib/new-york-submissions-store"

// Public write surface for "A Mosaic of New York" photo submissions: the in-page
// upload flow posts up to five images here. Files land in a private Storage
// bucket as `pending` and one row per photo is inserted with the service key, so
// this is the only public write and is validated + rate-limited accordingly: a
// per-IP hourly cap (in photos) and a global hourly cap bounding total new
// storage.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for")
  if (fwd) return fwd.split(",")[0]!.trim()
  return request.headers.get("x-real-ip")?.trim() || "unknown"
}

const ALLOWED = new Set<string>(ALLOWED_CONTENT_TYPES)

// Sniff the leading bytes so a renamed/mistyped file can't sneak past the
// content-type check. HEIC/HEIF carry an `ftyp` box a few bytes in; we accept
// those by the declared type since their brands vary.
function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg"
  if (
    bytes.length > 7 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png"
  if (
    bytes.length > 11 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp"
  if (bytes.length > 2 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return "image/gif"
  if (
    bytes.length > 11 &&
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  )
    return "heif" // ftyp box — HEIC/HEIF (and some other ISO-BMFF); brand varies
  return null
}

export async function POST(request: Request) {
  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return new Response("Invalid form data", { status: 400 })
  }

  const files = form
    .getAll("photos")
    .filter((entry): entry is File => entry instanceof File && entry.size > 0)

  if (files.length === 0) {
    return Response.json({ error: "Add at least one photo." }, { status: 400 })
  }
  if (files.length > MAX_FILES_PER_SUBMISSION) {
    return Response.json(
      { error: `You can upload at most ${MAX_FILES_PER_SUBMISSION} photos.` },
      { status: 400 }
    )
  }

  // Credit: opt-in. A blank/absent name means "don't credit me".
  const rawName = form.get("creditName")
  let creditName: string | null = null
  if (typeof rawName === "string") {
    const trimmed = rawName.trim()
    if (trimmed.length > MAX_CREDIT_NAME_LENGTH) {
      return Response.json({ error: "That name is too long." }, { status: 400 })
    }
    creditName = trimmed || null
  }

  const photos: SubmissionPhoto[] = []
  for (const file of files) {
    if (file.size > MAX_IMAGE_BYTES) {
      return Response.json(
        { error: `Each photo must be ${MAX_IMAGE_BYTES / (1024 * 1024)} MB or smaller.` },
        { status: 413 }
      )
    }
    const bytes = new Uint8Array(await file.arrayBuffer())
    const sniffed = sniffImageType(bytes)
    const declared = file.type
    // Accept when the bytes look like an image and the declared type is one we
    // allow. HEIC/HEIF sniff as a generic ftyp box, so for those trust the
    // declared image/heic|heif.
    const declaredOk = ALLOWED.has(declared)
    const bytesOk =
      sniffed === declared ||
      (sniffed === "heif" && (declared === "image/heic" || declared === "image/heif"))
    if (!declaredOk || !bytesOk) {
      return Response.json(
        { error: "Only JPEG, PNG, WebP, GIF, or HEIC images are allowed." },
        { status: 415 }
      )
    }
    photos.push({
      bytes,
      contentType: declared,
      originalFilename: file.name || null,
    })
  }

  const ipHash = hashIp(clientIp(request))

  try {
    // Per-IP hourly cap, counted in photos. Reject the whole submission if it
    // would push this IP over the limit.
    const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const recent = await countRecentByIp(ipHash, sinceIso)
    if (recent + photos.length > RATE_LIMIT_PER_HOUR) {
      return Response.json(
        {
          error:
            "You've reached the upload limit for now. Please try again in an hour.",
        },
        { status: 429 }
      )
    }

    const { count } = await submitPhotos({ photos, creditName, ipHash })
    return Response.json({ ok: true, count })
  } catch (err) {
    if (err instanceof SubmissionsCapExceededError) {
      return Response.json(
        { error: "We're getting a lot of uploads right now — please try again shortly." },
        { status: 503 }
      )
    }
    if (err instanceof SubmissionsStoreNotConfiguredError) {
      return Response.json(
        { error: "Uploads aren't configured on this deployment." },
        { status: 503 }
      )
    }
    return Response.json({ error: "Failed to save your photos." }, { status: 500 })
  }
}
