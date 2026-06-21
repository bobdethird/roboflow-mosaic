import { promises as fs } from "node:fs"
import path from "node:path"

import type {
  GalleryIndexEntry,
  GalleryTile,
  GalleryTileMap,
} from "@/lib/gallery"
import { validateEncodedGeometry } from "@/lib/mosaic-geometry"
import { isLocalhostHost } from "@/lib/localhost-only"

// Dev-only sink for the /bake harness: writes one baked mosaic's image + hover
// hit-map into public/gallery and merges it into the gallery index. Guarded so
// it can never run (or touch the filesystem) in production.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type SaveBody = {
  name: string
  alt: string
  // data:image/jpeg;base64,... of the baked mosaic.
  image: string
  w: number
  h: number
  cols: number
  rows: number
  grid: number[]
  tiles: GalleryTile[]
  // Encoded per-tile zoom geometry (optional, written as foo.geometry.json).
  geometry?: unknown
}

// Conservative filename allowlist so a name can't escape public/gallery.
const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*$/i

export async function POST(request: Request) {
  if (
    process.env.NODE_ENV === "production" ||
    !isLocalhostHost(request.headers.get("host"))
  ) {
    return new Response("Not found", { status: 404 })
  }

  let body: SaveBody
  try {
    body = (await request.json()) as SaveBody
  } catch {
    return new Response("Invalid JSON", { status: 400 })
  }

  if (!body?.name || !SAFE_NAME.test(body.name) || body.name.includes("..")) {
    return new Response("Invalid name", { status: 400 })
  }
  const match = /^data:image\/\w+;base64,(.+)$/.exec(body.image ?? "")
  if (!match) {
    return new Response("Invalid image", { status: 400 })
  }

  const dir = path.join(process.cwd(), "public", "gallery")
  await fs.mkdir(dir, { recursive: true })

  await fs.writeFile(
    path.join(dir, `${body.name}.jpg`),
    Buffer.from(match[1], "base64")
  )

  const tileMap: GalleryTileMap = {
    w: body.w,
    h: body.h,
    cols: body.cols,
    rows: body.rows,
    grid: body.grid,
    tiles: body.tiles,
  }
  await fs.writeFile(
    path.join(dir, `${body.name}.json`),
    JSON.stringify(tileMap)
  )

  // Validate + write the zoom geometry beside the image, if provided.
  let hasGeometry = false
  if (body.geometry !== undefined) {
    const geo = validateEncodedGeometry(body.geometry)
    if (!geo) return new Response("Invalid geometry", { status: 400 })
    await fs.writeFile(
      path.join(dir, `${body.name}.geometry.json`),
      JSON.stringify(geo)
    )
    hasGeometry = true
  }

  const indexPath = path.join(dir, "index.json")
  let index: GalleryIndexEntry[] = []
  try {
    index = JSON.parse(await fs.readFile(indexPath, "utf8"))
  } catch {
    index = []
  }
  const entry: GalleryIndexEntry = {
    name: body.name,
    src: `/gallery/${body.name}.jpg`,
    w: body.w,
    h: body.h,
    alt: body.alt || body.name,
    ...(hasGeometry
      ? { geometrySrc: `/gallery/${body.name}.geometry.json` }
      : {}),
  }
  const existing = index.findIndex((it) => it.name === body.name)
  if (existing >= 0) index[existing] = entry
  else index.push(entry)
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2))

  return Response.json({ ok: true })
}
