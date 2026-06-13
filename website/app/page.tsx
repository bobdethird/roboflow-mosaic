import Link from "next/link"
import { ArrowRight } from "lucide-react"

import { Button } from "@/components/ui/button"

export default function Page() {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <div className="flex max-w-md min-w-0 flex-col items-start gap-6">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-medium tracking-tight">Photo mosaic</h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            An experimental mosaic built from thousands of frames sampled out of
            Knicks footage. Drop in a reference image and watch it reassemble —
            hover any tile to see the moment behind it.
          </p>
        </div>

        <section className="flex flex-col items-start gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">works</h2>
          <Button asChild>
            <Link href="/knicks-mosaic">
              knicks mosaic
              <ArrowRight />
            </Link>
          </Button>
        </section>

        <div className="font-mono text-xs text-muted-foreground">
          (Press <kbd>d</kbd> to toggle dark mode)
        </div>
      </div>
    </div>
  )
}
