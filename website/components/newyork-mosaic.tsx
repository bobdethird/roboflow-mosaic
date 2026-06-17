"use client"

import * as React from "react"

import {
  GALLERY_INDEX_URL,
  NY_MOSAIC_NAME_PREFIX,
  type GalleryIndexEntry,
} from "@/lib/gallery"
import { SingleMosaic } from "@/components/mosaic-gallery"

// The source photo, shown as-is until it's been baked into an interactive
// mosaic via the /bake harness. Its aspect ratio caps the fallback height.
const FALLBACK_SRC = "/gallery-original/nyc-lunch.png"
const FALLBACK_W = 2732
const FALLBACK_H = 2147
const MAX_VIEWPORT_HEIGHT = 58

// Renders the New York hero as a live mosaic (hover on desktop, drag on touch)
// once it exists in the baked gallery index; falls back to the plain photo so
// the page never looks broken before the first bake.
export function NewYorkMosaic() {
  const [entry, setEntry] = React.useState<GalleryIndexEntry | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(GALLERY_INDEX_URL)
        if (!res.ok) return
        const data = (await res.json()) as GalleryIndexEntry[]
        const found = data.find((it) =>
          it.name.startsWith(NY_MOSAIC_NAME_PREFIX)
        )
        if (!cancelled && found) setEntry(found)
      } catch {
        // Leave the fallback in place if the index can't be read.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (entry) {
    return <SingleMosaic entry={entry} maxViewportHeight={MAX_VIEWPORT_HEIGHT} />
  }

  return (
    <div
      className="mx-auto w-full"
      style={{
        maxWidth: `calc(${MAX_VIEWPORT_HEIGHT}svh * ${FALLBACK_W} / ${FALLBACK_H})`,
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- static public asset */}
      <img
        src={FALLBACK_SRC}
        alt="Lunch atop a Skyscraper — workers on a beam high above New York"
        className="block w-full rounded-lg border"
      />
    </div>
  )
}
