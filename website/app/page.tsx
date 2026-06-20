import Link from "next/link"

import { SiteCredit } from "@/components/site-credit"
import { MosaicGallery } from "@/components/mosaic-gallery"
import {
  TileHint,
  MobileTileHint,
  MobileIntroAnnouncement,
} from "@/components/tile-hint"
import { ThemeToggle } from "@/components/theme-toggle"
import { HomeCta } from "@/components/home-cta"

export default function Page() {
  return (
    <main
      className="flex min-h-svh flex-col items-center gap-9 px-2 pt-10 pb-28 sm:pt-12 sm:pb-32"
      style={{ fontFamily: "var(--font-mean-hand)" }}
    >
      <ThemeToggle />

      {/* First-visit mobile welcome explaining the drag-to-reveal interaction. */}
      <MobileIntroAnnouncement />

      {/* Hero title + small intro. */}
      <header className="flex w-full max-w-7xl flex-col items-center gap-4 md:flex-row md:items-end md:justify-between md:gap-8">
        <h1 className="max-w-[11ch] text-center text-5xl leading-none font-light tracking-tight text-balance sm:text-6xl md:text-left md:text-7xl lg:text-8xl">
          NEW YORK OR NOWHERE
        </h1>
        <p className="max-w-lg self-center text-center font-sans text-sm leading-[1.80] text-pretty text-foreground sm:text-base md:self-end md:text-right">
          <Link
            href="/newyork-mosaic"
            className="underline underline-offset-4 transition-colors hover:text-foreground"
          >
            the whole is greater than the sum of its parts
          </Link>
          <span className="mt-6 block md:mt-8 lg:mt-10">
            New York, and especially the Knicks, are a beautiful reflection
            of this theme. The melting pot of backgrounds, experiences, and
            perspectives creates a place on Earth like no other; one filled
            with culture, uniqueness, and impossible dreams.
            This project pays homage to what makes New York so special. Each 
            mosaic is composed of thousands of tiles - each a moment of Knicks 
            history leading us to this point, whether it be the players, the fans, 
            or the legacy.
          </span>
        </p>
      </header>

      <HomeCta />

      {/* Persistent hint for mobile + tablet; the wide desktop gutter gets the
          curly arrow instead. */}
      <MobileTileHint />

      {/* Gallery of mosaics — hover any one to see the footage frame behind a tile. */}
      <div className="relative w-full max-w-7xl">
        <TileHint />
        <MosaicGallery className="w-full" />
      </div>

      <SiteCredit />
    </main>
  )
}
