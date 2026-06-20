import { cache } from "react"
import { notFound } from "next/navigation"
import { headers } from "next/headers"
import type { Metadata } from "next"

import { SingleMosaic } from "@/components/mosaic-gallery"
import { MobileIntroAnnouncement } from "@/components/tile-hint"
import { SiteCredit } from "@/components/site-credit"
import { getMosaic } from "@/lib/mosaic-share-store"
import type { GalleryIndexEntry } from "@/lib/gallery"

// A shared mosaic view. Reuses the gallery's hover-to-reveal interaction against
// the stored composite + hit-map, served from the public /m/[id]/image and
// /m/[id]/tilemap routes. SingleMosaic is a client component; this page stays a
// server component so it can resolve the row and emit unfurl metadata.
export const runtime = "nodejs"
export const dynamic = "force-dynamic"

// Deduped between generateMetadata and the page render within one request.
const loadMosaic = cache(async (id: string) => {
  try {
    return await getMosaic(id)
  } catch {
    return null
  }
})

async function requestOrigin(): Promise<string> {
  const h = await headers()
  const host = h.get("host")
  if (!host) return ""
  const proto = h.get("x-forwarded-proto") ?? "https"
  return `${proto}://${host}`
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const row = await loadMosaic(id)
  if (!row) return { title: "Mosaic not found" }

  const origin = await requestOrigin()
  const imageUrl = `${origin}/m/${id}/image`
  const title = "A mosaic, made of moments"
  const description =
    "Every tile is a real photo. Hover anywhere to reveal the shot behind it — then make your own."

  return {
    title,
    description,
    // Unlisted for now: links unfurl, but these aren't surfaced to search.
    robots: { index: false, follow: false },
    openGraph: {
      title,
      description,
      type: "website",
      url: `${origin}/m/${id}`,
      images: [{ url: imageUrl, width: row.w, height: row.h }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
  }
}

export default async function SharedMosaicPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const row = await loadMosaic(id)
  if (!row) notFound()

  const entry: GalleryIndexEntry = {
    name: id,
    src: `/m/${id}/image`,
    tileMapSrc: `/m/${id}/tilemap`,
    w: row.w,
    h: row.h,
    alt: "A photo mosaic",
  }

  return (
    <main className="mx-auto flex min-h-svh max-w-5xl flex-col gap-6 px-4 py-8 font-sans sm:py-12">
      {/* First-visit, mobile-only hint for shared-link recipients. Its own cookie
          (independent of the home intro) so someone arriving straight from a
          shared link still learns the tap-then-drag interaction, shown once. */}
      <MobileIntroAnnouncement
        cookieName="mosaic_share_intro_seen"
        description="Tap the image to open it, then drag your finger across it to reveal the photos that make it up."
      />

      <header className="flex flex-col gap-1 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-balance">
          A mosaic, made of moments
        </h1>
        <p className="text-sm text-muted-foreground">
          Hover or drag across the image to reveal the photo behind each tile.
        </p>
      </header>

      <div className="flex flex-1 items-center justify-center">
        <SingleMosaic entry={entry} maxViewportHeight={72} />
      </div>

      <footer className="flex flex-col items-center gap-5 text-center text-sm text-muted-foreground">
        <a
          href="https://www.knicksmosaic.com/knicks-mosaic"
          className="font-medium text-foreground underline"
        >
          Make your own mosaic →
        </a>
        <SiteCredit />
      </footer>
    </main>
  )
}
