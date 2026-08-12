"use client"

import * as React from "react"
import Link from "next/link"
import { ArrowRight } from "lucide-react"

import { Button } from "@/components/ui/button"

const inlineButtonClassName =
  "h-12 w-full gap-2 rounded-none border-0 px-7 text-base shadow-2xl shadow-black/30 ring-0 sm:h-14 sm:text-lg"

const dockedButtonClassName =
  "h-12 gap-2 rounded-none border-0 px-7 text-base shadow-2xl shadow-black/30 ring-0"

function TryItOutButton({ className }: { className: string }) {
  return (
    <Button asChild className={className}>
      <Link href="/knicks-mosaic">
        try it out
        <ArrowRight className="size-5 transition-transform duration-200 group-hover/button:translate-x-1" />
      </Link>
    </Button>
  )
}

export function HomeCta() {
  const inlineCtaRef = React.useRef<HTMLDivElement>(null)
  const [isDocked, setIsDocked] = React.useState(false)

  React.useEffect(() => {
    const inlineCta = inlineCtaRef.current

    if (!inlineCta) return

    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsDocked(!entry.isIntersecting)
      },
      { threshold: 0.01 }
    )

    observer.observe(inlineCta)

    return () => observer.disconnect()
  }, [])

  return (
    <>
      {/* Primary call to action, placed before the gallery so visitors see it
          immediately after the page's intro. */}
      <div ref={inlineCtaRef} className="w-full max-w-7xl">
        <TryItOutButton className={inlineButtonClassName} />
      </div>

      {isDocked ? (
        <div className="fixed inset-x-0 bottom-8 z-40 flex justify-center px-4 sm:bottom-10">
          <TryItOutButton className={dockedButtonClassName} />
        </div>
      ) : null}
    </>
  )
}
