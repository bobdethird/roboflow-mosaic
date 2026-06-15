import Image from "next/image"
import Link from "next/link"
import { ArrowRight } from "lucide-react"

import { Button } from "@/components/ui/button"

const EXAMPLES = [
  {
    src: "/examples/mosaic-player.jpg",
    width: 960,
    height: 1200,
    alt: "A Knicks player mid-drive, rebuilt as a mosaic of thousands of footage frames",
  },
  {
    src: "/examples/mosaic-celebration.jpg",
    width: 1900,
    height: 1192,
    alt: "Knicks players and fans celebrating, rebuilt as a mosaic of thousands of footage frames",
  },
]

export default function Page() {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-12 px-6 py-16 sm:py-20">
      {/* Small intro — the meaning of the piece. */}
      <header className="flex max-w-xl flex-col items-center gap-3 text-center">
        <p className="font-mono text-xs tracking-[0.2em] text-muted-foreground uppercase">
          New York Knicks · Photo Mosaic
        </p>
        <p className="text-sm leading-relaxed text-balance text-muted-foreground">
          An artistic tribute to the Knicks&rsquo; championship — each portrait
          of the moment reassembled from thousands of frames pulled from the
          footage. Drop in any image and watch it rebuild itself; hover a tile
          to see the play behind it.
        </p>
      </header>

      {/* Examples of what the mosaic produces. */}
      <div className="flex flex-col items-center gap-3">
        <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-4">
          {EXAMPLES.map((ex) => (
            <Image
              key={ex.src}
              src={ex.src}
              width={ex.width}
              height={ex.height}
              alt={ex.alt}
              priority
              sizes="(min-width: 1024px) 33vw, 90vw"
              draggable={false}
              className="h-56 w-auto border bg-card object-cover select-none sm:h-72 lg:h-80"
            />
          ))}
        </div>
        <p className="font-mono text-[0.7rem] tracking-wide text-muted-foreground">
          built from frames of Knicks footage — hover any tile to see its source
        </p>
      </div>

      {/* Call to action. */}
      <Button asChild className="h-10 px-5 text-sm">
        <Link href="/knicks-mosaic">
          try it out
          <ArrowRight />
        </Link>
      </Button>

      <p className="font-mono text-xs text-muted-foreground">
        (Press <kbd>d</kbd> to toggle dark mode)
      </p>
    </main>
  )
}
