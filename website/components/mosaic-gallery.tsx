"use client"

import * as React from "react"
import { X } from "lucide-react"

import {
  GALLERY_INDEX_URL,
  tileMapUrlFor,
  type GalleryIndexEntry,
  type GalleryTile,
  type GalleryTileMap,
} from "@/lib/gallery"
import { cn } from "@/lib/utils"

type Hover = { tile: GalleryTile; fx: number; fy: number }
type PointerCoords = { clientX: number; clientY: number }
const GALLERY_COLUMN_BREAKPOINT = "(min-width: 640px)"

function shuffled<T>(items: T[]): T[] {
  const next = [...items]
  for (let i = next.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[next[i], next[j]] = [next[j], next[i]]
  }
  return next
}

function useGalleryColumnCount() {
  const [columnCount, setColumnCount] = React.useState(2)

  React.useEffect(() => {
    const query = window.matchMedia(GALLERY_COLUMN_BREAKPOINT)
    const update = () => setColumnCount(query.matches ? 3 : 2)

    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [])

  return columnCount
}

function columnizeGalleryItems(
  items: GalleryIndexEntry[],
  columnCount: number
): GalleryIndexEntry[][] {
  const columns = Array.from({ length: columnCount }, () => [] as GalleryIndexEntry[])
  const heights = new Array<number>(columnCount).fill(0)

  for (const item of items) {
    let shortestColumn = 0
    for (let i = 1; i < heights.length; i++) {
      if (heights[i] < heights[shortestColumn]) shortestColumn = i
    }

    columns[shortestColumn].push(item)
    heights[shortestColumn] += item.h / Math.max(1, item.w)
  }

  return columns
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

function previewUrlFor(tile: GalleryTile): string {
  if (tile.previewUrl) return tile.previewUrl

  const originalMatch = tile.url.match(/^(.*\/)originals\/([^?#]+)([?#].*)?$/)
  if (!originalMatch) return tile.url

  return `${originalMatch[1]}thumbs/${originalMatch[2]}.jpg${originalMatch[3] ?? ""}`
}

function HoverPreviewImage({ tile }: { tile: GalleryTile }) {
  const primarySrc = previewUrlFor(tile)
  const [useFallback, setUseFallback] = React.useState(false)
  const src = useFallback ? tile.url : primarySrc

  return (
    // eslint-disable-next-line @next/next/no-img-element -- proxied library URL, hover preview only
    <img
      src={src}
      alt={tile.title}
      decoding="async"
      draggable={false}
      onError={() => {
        if (src !== tile.url) setUseFallback(true)
      }}
      className="size-full object-contain"
    />
  )
}

// One baked mosaic: a static image whose hover reveals the Knicks source frame
// behind the spot under the cursor, just like /knicks-mosaic. The per-mosaic hit
// map is fetched lazily the first time the pointer enters the tile.
function MosaicCell({
  item,
  onOpen,
}: {
  item: GalleryIndexEntry
  onOpen: () => void
}) {
  const [hover, setHover] = React.useState<Hover | null>(null)
  const cellRef = React.useRef<HTMLDivElement | null>(null)
  const mapRef = React.useRef<GalleryTileMap | null>(null)
  const mapPromiseRef = React.useRef<Promise<GalleryTileMap | null> | null>(null)
  const hoveringRef = React.useRef(false)
  const lastPointerRef = React.useRef<PointerCoords | null>(null)
  const frameRef = React.useRef<number | null>(null)
  // Track touch double-taps (no hover on touch, so a double-tap opens the
  // enlarged view) and the last pointer type so a single tap doesn't try to
  // open a tile the way a desktop hover-click does.
  const lastTapRef = React.useRef<{ time: number; x: number; y: number } | null>(
    null
  )
  const pointerTypeRef = React.useRef<string>("mouse")

  const ensureMap = React.useCallback(() => {
    if (mapRef.current) return Promise.resolve(mapRef.current)
    if (mapPromiseRef.current) return mapPromiseRef.current

    mapPromiseRef.current = (async () => {
      try {
        const res = await fetch(tileMapUrlFor(item.src))
        if (!res.ok) return null
        const map = (await res.json()) as GalleryTileMap
        mapRef.current = map
        return map
      } catch {
        // Hover preview is best-effort; the image still shows without it.
        return null
      } finally {
        mapPromiseRef.current = null
      }
    })()

    return mapPromiseRef.current
  }, [item.src])

  const updateHover = React.useCallback((coords: PointerCoords) => {
    const map = mapRef.current
    const node = cellRef.current
    if (!map || !node) return

    const rect = node.getBoundingClientRect()
    const fx = (coords.clientX - rect.left) / rect.width
    const fy = (coords.clientY - rect.top) / rect.height
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

  const scheduleHoverUpdate = React.useCallback(
    (coords: PointerCoords) => {
      lastPointerRef.current = coords
      if (frameRef.current !== null) return

      frameRef.current = window.requestAnimationFrame(() => {
        frameRef.current = null
        const latest = lastPointerRef.current
        if (latest && hoveringRef.current) updateHover(latest)
      })
    },
    [updateHover]
  )

  const onEnter = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      pointerTypeRef.current = e.pointerType
      // Touch has no real hover; the inline preview just flickers and confuses,
      // so touch users get the double-tap → enlarged view instead.
      if (e.pointerType !== "mouse") return
      hoveringRef.current = true
      scheduleHoverUpdate({ clientX: e.clientX, clientY: e.clientY })
      void ensureMap().then((map) => {
        const latest = lastPointerRef.current
        if (map && latest && hoveringRef.current) scheduleHoverUpdate(latest)
      })
    },
    [ensureMap, scheduleHoverUpdate]
  )

  const onMove = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType !== "mouse") return
      scheduleHoverUpdate({ clientX: e.clientX, clientY: e.clientY })
    },
    [scheduleHoverUpdate]
  )

  // Detect a double-tap on touch/pen and open the enlarged view.
  const onPointerUp = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      pointerTypeRef.current = e.pointerType
      if (e.pointerType === "mouse") return
      const now = Date.now()
      const prev = lastTapRef.current
      if (
        prev &&
        now - prev.time < 300 &&
        Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < 30
      ) {
        lastTapRef.current = null
        onOpen()
      } else {
        lastTapRef.current = { time: now, x: e.clientX, y: e.clientY }
      }
    },
    [onOpen]
  )

  const onLeave = React.useCallback(() => {
    hoveringRef.current = false
    lastPointerRef.current = null
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
    setHover(null)
  }, [])

  React.useEffect(() => {
    return () => {
      hoveringRef.current = false
      lastPointerRef.current = null
      if (frameRef.current !== null) {
        window.cancelAnimationFrame(frameRef.current)
      }
    }
  }, [])

  return (
    <div
      ref={cellRef}
      className="relative block w-full cursor-pointer touch-manipulation"
      style={{ zIndex: hover ? 30 : undefined }}
      onPointerEnter={onEnter}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
      onPointerUp={onPointerUp}
      onClick={() => {
        if (pointerTypeRef.current !== "mouse") return
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
          className="pointer-events-none absolute z-10 w-40 overflow-hidden rounded-2xl border bg-popover p-2 font-sans shadow-lg sm:w-52"
          style={{
            left: `${hover.fx * 100}%`,
            top: `${hover.fy * 100}%`,
            transform: `translate(${
              hover.fx > 0.5 ? "calc(-100% - 12px)" : "12px"
            }, ${hover.fy > 0.5 ? "calc(-100% - 12px)" : "12px"})`,
          }}
        >
          <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-card">
            <HoverPreviewImage
              key={previewUrlFor(hover.tile)}
              tile={hover.tile}
            />
            <span className="absolute inset-x-0 bottom-0 line-clamp-2 bg-black/70 px-2 py-1.5 text-left text-xs font-medium text-[var(--cream)]">
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

// Mobile-friendly enlarged view. Double-tapping a gallery mosaic opens this
// overlay; tapping or dragging across the enlarged image reveals the Knicks
// source frame behind each region — the touch equivalent of the desktop hover.
function MosaicLightbox({
  item,
  onClose,
}: {
  item: GalleryIndexEntry
  onClose: () => void
}) {
  const [map, setMap] = React.useState<GalleryTileMap | null>(null)
  const [hover, setHover] = React.useState<Hover | null>(null)
  const wrapRef = React.useRef<HTMLDivElement | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await fetch(tileMapUrlFor(item.src))
        if (!res.ok) return
        const data = (await res.json()) as GalleryTileMap
        if (!cancelled) setMap(data)
      } catch {
        // Reveal is best-effort; the enlarged image still shows without it.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [item.src])

  // Lock background scroll while open and close on Escape.
  React.useEffect(() => {
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = "hidden"
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => {
      document.body.style.overflow = prevOverflow
      window.removeEventListener("keydown", onKey)
    }
  }, [onClose])

  const reveal = React.useCallback(
    (coords: PointerCoords) => {
      const node = wrapRef.current
      if (!node || !map) return
      const rect = node.getBoundingClientRect()
      const fx = (coords.clientX - rect.left) / rect.width
      const fy = (coords.clientY - rect.top) / rect.height
      if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return
      const tile = tileAt(map, fx, fy)
      setHover(tile ? { tile, fx, fy } : null)
    },
    [map]
  )

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4 font-sans backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        type="button"
        aria-label="Close enlarged view"
        onClick={onClose}
        className="absolute top-4 right-4 z-10 flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
      >
        <X className="size-5" />
      </button>

      <div
        ref={wrapRef}
        className="relative touch-none"
        style={{
          width: `min(92vw, calc(85svh * ${item.w} / ${item.h}))`,
          aspectRatio: `${item.w} / ${item.h}`,
        }}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => reveal({ clientX: e.clientX, clientY: e.clientY })}
        onPointerMove={(e) => reveal({ clientX: e.clientX, clientY: e.clientY })}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- static baked asset */}
        <img
          src={item.src}
          alt={item.alt}
          draggable={false}
          className="absolute inset-0 size-full rounded-lg object-cover select-none"
        />

        {hover && (
          <div
            className="absolute z-10 w-44 overflow-hidden rounded-2xl border bg-white p-2 shadow-lg sm:w-56"
            style={{
              left: `${hover.fx * 100}%`,
              top: `${hover.fy * 100}%`,
              transform: `translate(${
                hover.fx > 0.5 ? "calc(-100% - 16px)" : "16px"
              }, ${hover.fy > 0.5 ? "calc(-100% - 16px)" : "16px"})`,
            }}
          >
            <a
              href={hover.tile.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="block"
            >
              <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-white">
                <HoverPreviewImage
                  key={previewUrlFor(hover.tile)}
                  tile={hover.tile}
                />
                <span className="absolute inset-x-0 bottom-0 line-clamp-2 bg-black/70 px-2 py-1.5 text-left text-xs font-medium text-white">
                  {hover.tile.title}
                </span>
              </div>
            </a>
            <div className="mt-2 px-1 text-xs text-muted-foreground">
              tap to open
            </div>
          </div>
        )}
      </div>

      <p className="pointer-events-none absolute inset-x-0 bottom-[calc(env(safe-area-inset-bottom,0px)+1rem)] text-center text-sm text-white/70">
        {map
          ? "Tap or drag across the mosaic to reveal the footage frames"
          : "Loading…"}
      </p>
    </div>
  )
}

// Masonry of pre-baked mosaics. Each one is a real /knicks-mosaic render saved to
// public/gallery; hovering reveals the source footage frame behind that region.
export function MosaicGallery({ className }: { className?: string }) {
  const [items, setItems] = React.useState<GalleryIndexEntry[]>([])
  const [lightboxItem, setLightboxItem] =
    React.useState<GalleryIndexEntry | null>(null)
  const columnCount = useGalleryColumnCount()
  const columns = React.useMemo(
    () => columnizeGalleryItems(items, columnCount),
    [items, columnCount]
  )

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
    <>
      <div
        className={cn(
          "grid grid-cols-2 items-start gap-3 sm:grid-cols-3 [&_img]:select-none",
          className
        )}
      >
        {columns.map((column, index) => (
          <div key={index} className="flex min-w-0 flex-col gap-3">
            {column.map((item) => (
              <MosaicCell
                key={item.name}
                item={item}
                onOpen={() => setLightboxItem(item)}
              />
            ))}
          </div>
        ))}
      </div>

      {lightboxItem && (
        <MosaicLightbox
          item={lightboxItem}
          onClose={() => setLightboxItem(null)}
        />
      )}
    </>
  )
}
