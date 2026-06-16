"use client"

import * as React from "react"
import Image from "next/image"

export type Example = {
  src: string
  width: number
  height: number
  alt: string
}

// Slow, continuous drift of the auto-play (px per second).
const DRIFT = 22

// Horizontal marquee: several mosaics share one fixed-height row that drifts
// on its own and loops forever. The list is duplicated so the wrap is seamless,
// and the strip is moved with a transform so there's no scrollbar.
export function ExampleGallery({ examples }: { examples: Example[] }) {
  const trackRef = React.useRef<HTMLDivElement>(null)
  // Current X translate (px), kept within one copy's width via wrapping.
  const posRef = React.useRef(0)
  // Width of a single copy of the list (item-1 → its duplicate), gaps included.
  const periodRef = React.useRef(0)
  const pausedRef = React.useRef(false)
  const reduceRef = React.useRef(false)

  const count = examples.length

  const measure = React.useCallback(() => {
    const el = trackRef.current
    if (!el) return
    const first = el.children[0] as HTMLElement | undefined
    const dup = el.children[count] as HTMLElement | undefined
    if (first && dup) periodRef.current = dup.offsetLeft - first.offsetLeft
  }, [count])

  React.useEffect(() => {
    reduceRef.current = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches

    measure()
    window.addEventListener("resize", measure)

    let raf = 0
    let last = performance.now()
    const loop = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000)
      last = now
      const period = periodRef.current
      const el = trackRef.current
      if (el && period > 0 && !pausedRef.current && !reduceRef.current) {
        posRef.current -= DRIFT * dt
        // Keep pos in (-period, 0]; the duplicate copy fills the gap on wrap.
        while (posRef.current <= -period) posRef.current += period
        while (posRef.current > 0) posRef.current -= period
        el.style.transform = `translate3d(${posRef.current}px,0,0)`
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener("resize", measure)
    }
  }, [measure])

  const loop = [...examples, ...examples]

  return (
    <div
      className="relative w-full max-w-4xl overflow-hidden"
      onMouseEnter={() => (pausedRef.current = true)}
      onMouseLeave={() => (pausedRef.current = false)}
    >
      {/* Edge fades so images slide out of view softly. */}
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-12 bg-gradient-to-r from-background to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-12 bg-gradient-to-l from-background to-transparent" />

      <div
        ref={trackRef}
        className="flex h-56 gap-3 will-change-transform sm:h-72 sm:gap-4 lg:h-80"
      >
        {loop.map((ex, i) => (
          <Image
            key={`${ex.src}-${i}`}
            src={ex.src}
            width={ex.width}
            height={ex.height}
            alt={ex.alt}
            priority={i < count}
            sizes="(min-width: 1024px) 40vw, 70vw"
            draggable={false}
            onLoad={measure}
            className="h-full w-auto shrink-0 border bg-card object-cover select-none"
          />
        ))}
      </div>
    </div>
  )
}
