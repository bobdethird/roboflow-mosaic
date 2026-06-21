import { isAdminRequest } from "@/lib/mosaic-admin"
import {
  countRecentByIp,
  hashIp,
  publishMosaic,
  ShareStoreNotConfiguredError,
  MAX_DIMENSION,
  MAX_GEOMETRY_BYTES,
  MAX_IMAGE_BYTES,
  MAX_TILEMAP_BYTES,
  RATE_LIMIT_PER_HOUR,
  type StoredTileMap,
} from "@/lib/mosaic-share-store"
import { validateEncodedGeometry } from "@/lib/mosaic-geometry"
import type { GalleryTile } from "@/lib/gallery"

// Validate + canonicalize the optional zoom geometry. Returns the JSON string to
// store, undefined when absent, or null when present-but-invalid (a hard reject).
function parseGeometry(raw: unknown): string | undefined | null {
  if (typeof raw !== "string") return undefined
  if (raw.length > MAX_GEOMETRY_BYTES) return null
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  const geo = validateEncodedGeometry(data)
  if (!geo) return null
  return JSON.stringify(geo)
}

// Create a shared mosaic. Admin-gated for now (localhost or admin cookie);
// viewing the resulting /m/<id> link is public. Writes the composite image +
// hover hit-map to private Storage and inserts the index row, all with the
// service key — so this is the only new write surface and is validated/limited
// accordingly.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for")
  if (fwd) return fwd.split(",")[0]!.trim()
  return request.headers.get("x-real-ip")?.trim() || "unknown"
}

function isJpeg(bytes: Uint8Array): boolean {
  return (
    bytes.length > 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
}

// Validate the posted hit-map enough to trust it: right shape, sane sizes, and
// grid indices that point into the tiles array.
function parseTileMap(raw: string, w: number, h: number): StoredTileMap | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  if (!data || typeof data !== "object") return null
  const m = data as Record<string, unknown>
  const cols = m.cols
  const rows = m.rows
  const grid = m.grid
  const tiles = m.tiles
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    typeof cols !== "number" ||
    typeof rows !== "number" ||
    cols < 1 ||
    rows < 1 ||
    cols * rows > 4_000_000 ||
    !Array.isArray(grid) ||
    grid.length !== cols * rows ||
    !Array.isArray(tiles) ||
    tiles.length === 0 ||
    tiles.length > grid.length
  ) {
    return null
  }
  for (const g of grid) {
    if (
      !Number.isInteger(g) ||
      (g as number) < -1 ||
      (g as number) >= tiles.length
    ) {
      return null
    }
  }
  const cleanTiles: GalleryTile[] = []
  for (const t of tiles) {
    if (!t || typeof t !== "object") return null
    const tile = t as Record<string, unknown>
    if (typeof tile.url !== "string" || typeof tile.title !== "string")
      return null
    cleanTiles.push({
      url: tile.url,
      title: tile.title,
      previewUrl:
        typeof tile.previewUrl === "string" ? tile.previewUrl : undefined,
    })
  }
  return { w, h, cols, rows, grid: grid as number[], tiles: cleanTiles }
}

export async function POST(request: Request) {
  if (!(await isAdminRequest(request))) {
    return new Response("Forbidden", { status: 403 })
  }

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return new Response("Invalid form data", { status: 400 })
  }

  const image = form.get("image")
  const tilemapRaw = form.get("tilemap")
  const geometryRaw = form.get("geometry")
  const collection = form.get("collection")
  const w = Number(form.get("w"))
  const h = Number(form.get("h"))

  if (
    !(image instanceof Blob) ||
    typeof tilemapRaw !== "string" ||
    typeof collection !== "string" ||
    !collection ||
    collection.length > 64 ||
    !Number.isInteger(w) ||
    !Number.isInteger(h) ||
    w < 1 ||
    h < 1 ||
    w > MAX_DIMENSION ||
    h > MAX_DIMENSION
  ) {
    return new Response("Invalid payload", { status: 400 })
  }

  if (image.size === 0 || image.size > MAX_IMAGE_BYTES) {
    return new Response("Image too large", { status: 413 })
  }
  if (tilemapRaw.length > MAX_TILEMAP_BYTES) {
    return new Response("Tile map too large", { status: 413 })
  }

  const imageBytes = new Uint8Array(await image.arrayBuffer())
  if (!isJpeg(imageBytes)) {
    return new Response("Image must be JPEG", { status: 415 })
  }

  const tilemap = parseTileMap(tilemapRaw, w, h)
  if (!tilemap) {
    return new Response("Invalid tile map", { status: 400 })
  }

  const geometryJson = parseGeometry(geometryRaw)
  if (geometryJson === null) {
    return new Response("Invalid geometry", { status: 400 })
  }

  const ipHash = hashIp(clientIp(request))

  try {
    // Per-IP rate limit over the last hour.
    const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const recent = await countRecentByIp(ipHash, sinceIso)
    if (recent >= RATE_LIMIT_PER_HOUR) {
      return new Response("Rate limit exceeded", { status: 429 })
    }

    const { id, reused } = await publishMosaic({
      collection,
      w,
      h,
      imageBytes,
      tilemap,
      geometryJson: geometryJson ?? null,
      ipHash,
    })

    return Response.json({ id, url: `/m/${id}`, reused })
  } catch (err) {
    if (err instanceof ShareStoreNotConfiguredError) {
      return new Response(
        "Shared mosaics are not configured on this deployment.",
        { status: 503 }
      )
    }
    return new Response("Failed to publish mosaic", { status: 500 })
  }
}
