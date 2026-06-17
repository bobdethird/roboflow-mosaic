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
        <p className="max-w-lg self-end font-sans text-sm leading-relaxed text-right text-pretty text-muted-foreground sm:text-base">
          <Link
            href="/newyork-mosaic"
            className="underline underline-offset-4 transition-colors hover:text-foreground"
          >
            the whole is greater than the sum of its parts
          </Link>{" "}
          <br /> <br />
          
          New York City, and especially the Knicks, are a beautiful reflection of 
          this theme. The diversity of backgrounds, experiences, and perspectives
          that make a unique melting pot. This project pays homage
          to what makes New York so special. 
          
          <br /> <br />
          
          Each mosaic is composed of thousands of 
          tiles; each a different moment of Knicks history that led to this point. 
          Whether it be the players, the fans, or the legacy the team has built.
        </p>
      </header>

      {/* Gallery of mosaics — hover any one to see the footage frame behind a tile. */}
      <MosaicGallery className="w-full max-w-7xl" />

      {/* Docked call to action. */}
      <div className="fixed inset-x-0 bottom-5 z-40 flex justify-center px-4 sm:bottom-6">
        <Button
          asChild
          className="h-10 rounded-none border-0 px-5 text-sm shadow-lg ring-0"
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
