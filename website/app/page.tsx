import Link from "next/link"
import { ArrowRight } from "lucide-react"

import { Button } from "@/components/ui/button"
import { SiteCredit } from "@/components/site-credit"
import { ExampleGallery, type Example } from "@/components/example-gallery"
import { ThemeToggle } from "@/components/theme-toggle"

const EXAMPLES: Example[] = [
  {
    src: "/examples/mosaic-player.jpg",
    width: 960,
    height: 1200,
    alt: "Captain clutch, rebuilt as a mosaic of thousands of footage frames",
  },
  {
    src: "/examples/mosaic-celebration.jpg",
    width: 1900,
    height: 1192,
    alt: "Knicks players and fans celebrating, rebuilt as a mosaic of thousands of footage frames",
  },
  {
    src: "/examples/mosaic-crowd.jpg",
    width: 1600,
    height: 900,
    alt: "A jubilant Knicks crowd, rebuilt as a mosaic of thousands of footage frames",
  },
  {
    src: "/examples/mosaic-arena.jpg",
    width: 1600,
    height: 1068,
    alt: "A packed Madison Square Garden, rebuilt as a mosaic of thousands of footage frames",
  },
  {
    src: "/examples/mosaic-action.jpg",
    width: 1600,
    height: 1068,
    alt: "Knicks game action, rebuilt as a mosaic of thousands of footage frames",
  },
]

export default function Page() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-12 px-6 py-16 sm:py-20">
      <ThemeToggle />

      {/* Small intro — the meaning of the piece. */}
      <header className="flex max-w-xl flex-col items-center gap-3 text-center">
        <p className="font-mono text-xs tracking-[0.2em] text-muted-foreground uppercase">
          Mosaic
        </p>
        <p className="text-sm leading-relaxed text-balance text-muted-foreground">
          This one's for you, New York.
        </p>
      </header>

      {/* Examples of what the mosaic produces. */}
      <div className="flex flex-col items-center gap-3">
        <ExampleGallery examples={EXAMPLES} />
        <p className="font-mono text-[0.7rem] tracking-wide text-muted-foreground">
          How it works: reconstruct an image entirely from Knicks photos.
        </p>
      </div>

      {/* Call to action. */}
      <Button asChild className="h-10 px-5 text-sm">
        <Link href="/knicks-mosaic">
          try it out
          <ArrowRight />
        </Link>
      </Button>

      <SiteCredit />
    </main>
  )
}
