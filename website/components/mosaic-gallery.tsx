"use client"

import * as React from "react"

import {
  GALLERY_INDEX_URL,
  tileMapUrlFor,
  type GalleryIndexEntry,
  type GalleryTile,
  type GalleryTileMap,
} from "@/lib/gallery"
import { cn } from "@/lib/utils"

type Hover = { tile: GalleryTile; fx: number; fy: number }

function shuffled<T>(items: T[]): T[] {
  const next = [...items]
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[next[i], next[j]] = [next[j], next[i]]
  }
  return next
}

// Look up the source frame a normalized (0..1) pointer position lands on, with a
// small spiral fallback so the rare empty bucket borrows its nearest neighbor.
function tileAt(
  map: GalleryTileMap,
  fx: number,
  fy: number
): GalleryTile | null {
  const { cols, rows, grid, tiles } = map
  const gx = Math.min(cols - 1, Math.max(0, Math.floor(fx * cols)))
  const gy = Math.min(rows - 1, Math.max(0, Math.floor(fy * rows)))
  let idx = grid[gy * cols + gx]
  for (let r = 1; idx < 0 && r <= 4; r++) {
    for (let dy = -r; dy <= r && idx < 0; dy++) {
      for (let dx = -r; dx <= r && idx < 0; dx++) {
        const nx = gx + dx
        const ny = gy + dy
        if (nx < 0 || nx >= cols || ny < 0 || ny >= rows) continue
        const candidate = grid[ny * cols + nx]
        if (candidate >= 0) idx = candidate
      }
    }
  }
  return idx >= 0 ? (tiles[idx] ?? null) : null
}

// One baked mosaic: a static image whose hover reveals the Knicks source frame
// behind the spot under the cursor, just like /knicks-mosaic. The per-mosaic hit
// map is fetched lazily the first time the pointer enters the tile.
function MosaicCell({ item }: { item: GalleryIndexEntry }) {
  const [hover, setHover] = React.useState<Hover | null>(null)
  const mapRef = React.useRef<GalleryTileMap | null>(null)
  const loadingRef = React.useRef(false)

  const ensureMap = React.useCallback(() => {
    if (mapRef.current || loadingRef.current) return
    loadingRef.current = true
    void (async () => {
      try {
        const res = await fetch(tileMapUrlFor(item.src))
        if (res.ok) mapRef.current = (await res.json()) as GalleryTileMap
      } catch {
        // Hover preview is best-effort; the image still shows without it.
      }
    })()
  }, [item.src])

  const onMove = React.useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const map = mapRef.current
    if (!map) return
    const rect = e.currentTarget.getBoundingClientRect()
    const fx = (e.clientX - rect.left) / rect.width
    const fy = (e.clientY - rect.top) / rect.height
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return
    const tile = tileAt(map, fx, fy)
    setHover((prev) => {
      if (!tile) return prev === null ? prev : null
      if (prev && prev.tile === tile && prev.fx === fx && prev.fy === fy) {
        return prev
      }
      return { tile, fx, fy }
    })
  }, [])

  return (
    <div
      className="relative mb-3 block w-full cursor-pointer break-inside-avoid"
      style={{ zIndex: hover ? 30 : undefined }}
      onPointerEnter={ensureMap}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
      onClick={() => {
        if (hover) {
          window.open(hover.tile.url, "_blank", "noopener,noreferrer")
        }
      }}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- static baked asset, intrinsic-sized */}
      <img
        src={item.src}
        width={item.w}
        height={item.h}
        alt={item.alt}
        loading="lazy"
        draggable={false}
        className="block w-full rounded-lg border bg-card"
      />

      {hover && (
        <div
          aria-hidden
          className="pointer-events-none absolute z-10 w-40 overflow-hidden rounded-2xl border bg-white p-2 font-sans shadow-lg sm:w-52"
          style={{
            left: `${hover.fx * 100}%`,
            top: `${hover.fy * 100}%`,
            transform: `translate(${
              hover.fx > 0.5 ? "calc(-100% - 12px)" : "12px"
            }, ${hover.fy > 0.5 ? "calc(-100% - 12px)" : "12px"})`,
          }}
        >
          <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-white">
            {/* eslint-disable-next-line @next/next/no-img-element -- proxied library URL, hover preview only */}
            <img
              src={hover.tile.url}
              alt={hover.tile.title}
              draggable={false}
              className="size-full object-contain"
            />
            <span className="absolute inset-x-0 bottom-0 line-clamp-2 bg-black/70 px-2 py-1.5 text-left text-xs font-medium text-white">
              {hover.tile.title}
            </span>
          </div>
          <div className="mt-2 px-1 text-xs text-muted-foreground">
            click to open
          </div>
        </div>
      )}
    </div>
  )
}

// Masonry of pre-baked mosaics. Each one is a real /knicks-mosaic render saved to
// public/gallery; hovering reveals the source footage frame behind that region.
export function MosaicGallery({ className }: { className?: string }) {
  const [items, setItems] = React.useState<GalleryIndexEntry[]>([])

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(GALLERY_INDEX_URL)
        if (!res.ok) return
        const data = (await res.json()) as GalleryIndexEntry[]
        if (!cancelled) setItems(shuffled(data))
      } catch {
        // No baked gallery yet — render nothing rather than erroring.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  if (items.length === 0) return null

  return (
    <div
      className={cn(
        "columns-2 gap-3 sm:columns-3 [&_img]:select-none",
        className
      )}
    >
      {items.map((item) => (
        <MosaicCell key={item.name} item={item} />
      ))}
    </div>
  )
}
