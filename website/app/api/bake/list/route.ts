import { promises as fs } from "node:fs"
import path from "node:path"

import { isLocalhostHost } from "@/lib/localhost-only"

// Dev-only helper for the /bake harness: enumerates the original reference
// photos in public/gallery-original so the page can bake each into a mosaic.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const IMAGE_RE = /\.(jpe?g|png|webp|avif|gif)$/i

export async function GET(request: Request) {
  if (
    process.env.NODE_ENV === "production" ||
    !isLocalhostHost(request.headers.get("host"))
  ) {
    return new Response("Not found", { status: 404 })
  }
  const dir = path.join(process.cwd(), "public", "gallery-original")
  try {
    const entries = await fs.readdir(dir)
    const files = entries
      .filter((name) => IMAGE_RE.test(name) && !name.startsWith("."))
      .sort((a, b) => a.localeCompare(b))
    return Response.json({ files })
  } catch {
    return Response.json({ files: [] })
  }
}
