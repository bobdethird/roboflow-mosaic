import Link from "next/link"
import { ArrowRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { SiteCredit } from "@/components/site-credit"
import { MosaicGallery } from "@/components/mosaic-gallery"
import { ThemeToggle } from "@/components/theme-toggle"

export default function Page() {
  return (
    <main
      className="flex min-h-svh flex-col items-center gap-9 px-2 pt-10 pb-28 sm:pt-12 sm:pb-32"
      style={{ fontFamily: "var(--font-mean-hand)" }}
    >
      <ThemeToggle />

      {/* Hero title + small intro. */}
      <header className="flex w-full max-w-7xl flex-col gap-4 md:flex-row md:items-end md:justify-between md:gap-8">
        <h1 className="max-w-[11ch] text-left text-5xl leading-none font-light tracking-tight text-balance sm:text-6xl md:text-7xl lg:text-8xl">
          NEW YORK OR NOWHERE
        </h1>
        <p className="max-w-lg self-end font-sans text-sm leading-[1.80] text-right text-pretty text-foreground sm:text-base">
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

      {/* Hint on how to peek at the photo behind a tile. */}
      <p className="w-full max-w-7xl font-sans text-xs text-muted-foreground sm:text-sm">
        <span className="hidden md:inline">
          hover over a tile to see the smaller Knicks pictures
        </span>
        <span className="md:hidden">
          tap a picture, then hover over a tile to see the smaller ones that comprise the whole
        </span>
      </p>

      {/* Gallery of mosaics — hover any one to see the footage frame behind a tile. */}
      <MosaicGallery className="w-full max-w-7xl" />

      {/* Docked call to action. */}
      <div className="fixed inset-x-0 bottom-8 z-40 flex justify-center px-4 sm:bottom-10">
        <Button
          asChild
          className="h-10 rounded-none border-0 px-5 text-sm shadow-2xl shadow-black/30 ring-0"
        >
          <Link href="/knicks-mosaic">
            try it out
            <ArrowRight />
          </Link>
        </Button>
      </div>

      <SiteCredit />
    </main>
  )
}
