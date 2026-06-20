import { headers } from "next/headers"

import { CanvasHero } from "@/components/canvas-hero"
import { isAdminContext } from "@/lib/mosaic-admin"

const KNICKS_MAX_TILE_REUSE = 20
const KNICKS_MIN_CELL_SIZE = 8

export const metadata = {
  title: "Knicks photo mosaic (experiment)",
  robots: {
    index: false,
    follow: false,
  },
}

// Temp/experimental page: runs the regular photo mosaic against the
// `knicks-mosaic` collection, whose tiles are frames sampled (~0.33fps) from the
// scraped Knicks videos. Seed the bucket first with:
//   pnpm knicks:photo-frames && pnpm knicks:photo-seed
export default async function KnicksMosaicPage() {
  // Admin-only "Publish & share" visibility (localhost or a valid admin cookie),
  // decided server-side. Reading headers opts this page into dynamic rendering.
  const h = await headers()
  const isAdmin = await isAdminContext(h.get("host"), h.get("cookie"))

  return (
    <CanvasHero
      bucket="knicks-mosaic"
      maxTileReuse={KNICKS_MAX_TILE_REUSE}
      minCellSize={KNICKS_MIN_CELL_SIZE}
      eraEmphasis
      hideIntroCopy
      hideCollectionLabel
      isAdmin={isAdmin}
    />
  )
}
