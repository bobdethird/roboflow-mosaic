import { CanvasHero } from "@/components/canvas-hero"

const KNICKS_MAX_TILE_REUSE = 20

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
export default function KnicksMosaicPage() {
  return (
    <CanvasHero bucket="knicks-mosaic" maxTileReuse={KNICKS_MAX_TILE_REUSE} />
  )
}
