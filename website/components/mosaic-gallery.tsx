"use client"

import * as React from "react"
import { Maximize2 } from "lucide-react"

import {
  GALLERY_INDEX_URL,
  NY_MOSAIC_NAME_PREFIX,
  geometryUrlFor,
  tileMapUrlFor,
  type GalleryIndexEntry,
  type GalleryTile,
  type GalleryTileMap,
} from "@/lib/gallery"
import { decodeGeometry, type MosaicGeometry } from "@/lib/mosaic-geometry"
import { MosaicZoomViewer } from "@/components/mosaic-zoom-viewer"
import { cn } from "@/lib/utils"

// Lazily fetch + decode a mosaic's zoom geometry. Shared mosaics carry an
// explicit `geometrySrc` route; baked gallery items default to the foo.jpg →
// foo.geometry.json sibling. Returns null when none exists (older mosaics still
// zoom against the base image, just without the real-photo overlay).
function makeGeometryLoader(
  entry: GalleryIndexEntry
): () => Promise<MosaicGeometry | null> {
  const url = entry.geometrySrc ?? geometryUrlFor(entry.src)
  return async () => {
    try {
      const res = await fetch(url)
      if (!res.ok) return null
      return decodeGeometry(await res.json())
    } catch {
      return null
    }
  }
}

type Hover = { tile: GalleryTile; fx: number; fy: number }
type PointerCoords = { clientX: number; clientY: number }
const GALLERY_COLUMN_BREAKPOINT = "(min-width: 640px)"
const HOVER_FULL_IMAGE_DELAY_MS = 750

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
  const columns = Array.from(
    { length: columnCount },
    () => [] as GalleryIndexEntry[]
  )
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
  const [loadedFullSrc, setLoadedFullSrc] = React.useState<string | null>(null)
  const showFull = tile.url !== primarySrc && loadedFullSrc === tile.url

  React.useEffect(() => {
    if (tile.url === primarySrc) return
    let cancelled = false
    let img: HTMLImageElement | null = null
    const timer = window.setTimeout(() => {
      img = new Image()
      img.decoding = "async"
      img.onload = () => {
        if (!cancelled) setLoadedFullSrc(tile.url)
      }
      img.src = tile.url
    }, HOVER_FULL_IMAGE_DELAY_MS)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (img) img.onload = null
    }
  }, [primarySrc, tile.url])

  if (useFallback || tile.url === primarySrc) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- proxied library URL, shown only as a hover preview
      <img
        src={tile.url}
        alt={tile.title}
        decoding="async"
        draggable={false}
        className="size-full object-contain"
      />
    )
  }

  return (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element -- proxied library URL, shown only as a hover preview */}
      <img
        src={primarySrc}
        alt={tile.title}
        decoding="async"
        draggable={false}
        onError={() => setUseFallback(true)}
        className="size-full object-contain"
      />
      {showFull && (
        // eslint-disable-next-line @next/next/no-img-element -- delayed full-res hover preview
        <img
          src={tile.url}
          alt=""
          decoding="async"
          draggable={false}
          className="absolute inset-0 size-full object-contain"
        />
      )}
    </>
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
  const mapPromiseRef = React.useRef<Promise<GalleryTileMap | null> | null>(
    null
  )
  const hoveringRef = React.useRef(false)
  const lastPointerRef = React.useRef<PointerCoords | null>(null)
  const frameRef = React.useRef<number | null>(null)
  // Track where a touch started so a scroll/swipe isn't mistaken for a tap (a
  // tap opens the enlarged view on touch). Also remember the last pointer type
  // so a single tap doesn't try to open a tile the way a desktop hover-click does.
  const tapStartRef = React.useRef<{ x: number; y: number } | null>(null)
  const pointerTypeRef = React.useRef<string>("mouse")

  const ensureMap = React.useCallback(() => {
    if (mapRef.current) return Promise.resolve(mapRef.current)
    if (mapPromiseRef.current) return mapPromiseRef.current

    mapPromiseRef.current = (async () => {
      try {
        const res = await fetch(item.tileMapSrc ?? tileMapUrlFor(item.src))
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
  }, [item.src, item.tileMapSrc])

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

  const onPointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      pointerTypeRef.current = e.pointerType
      if (e.pointerType === "mouse") return
      tapStartRef.current = { x: e.clientX, y: e.clientY }
    },
    []
  )

  // A single tap on touch/pen opens the enlarged view — as long as the finger
  // didn't travel far (which would be a scroll, not a tap).
  const onPointerUp = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      pointerTypeRef.current = e.pointerType
      if (e.pointerType === "mouse") return
      const start = tapStartRef.current
      tapStartRef.current = null
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 12) {
        onOpen()
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
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onClick={() => {
        // Desktop click opens the zoom explorer (where clicking a tile then
        // opens its source); touch opens it via the tap handler above.
        if (pointerTypeRef.current !== "mouse") return
        onOpen()
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
            click to zoom into mosaic
          </div>
        </div>
      )}
    </div>
  )
}

// Open one mosaic in the zoom explorer: pan/pinch to zoom and the composite
// resolves into the real source photos that make it up. Replaces the old
// tap-to-reveal lightbox — zooming in *is* the reveal, and clicking a tile opens
// its source. The geometry is fetched lazily on open.
function MosaicZoomLightbox({
  item,
  onClose,
}: {
  item: GalleryIndexEntry
  onClose: () => void
}) {
  const loadGeometry = React.useMemo(() => makeGeometryLoader(item), [item])
  return (
    <MosaicZoomViewer
      baseSrc={item.src}
      frameW={item.w}
      frameH={item.h}
      alt={item.alt}
      loadGeometry={loadGeometry}
      onClose={onClose}
    />
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
        // Skip the New York page's hero so it doesn't show up in the masonry.
        const filtered = data.filter(
          (it) => !it.name.startsWith(NY_MOSAIC_NAME_PREFIX)
        )
        if (!cancelled) setItems(shuffled(filtered))
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
        <MosaicZoomLightbox
          item={lightboxItem}
          onClose={() => setLightboxItem(null)}
        />
      )}
    </>
  )
}

// A single baked mosaic (e.g. the New York page hero or a shared /m view). Hover
// reveals source frames on desktop; clicking (or tapping on touch) opens the zoom
// explorer where the mosaic resolves into its real source photos. Width is capped
// so the rendered height fits the viewport, leaving room for surrounding content.
export function SingleMosaic({
  entry,
  className,
  maxViewportHeight,
}: {
  entry: GalleryIndexEntry
  className?: string
  /** Caps width from aspect ratio so height stays within this % of the viewport. */
  maxViewportHeight?: number
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <div
      className={cn(
        "group relative w-full",
        maxViewportHeight != null && "mx-auto",
        className
      )}
      style={
        maxViewportHeight != null
          ? {
              maxWidth: `calc(${maxViewportHeight}svh * ${entry.w} / ${entry.h})`,
            }
          : undefined
      }
    >
      <MosaicCell item={entry} onOpen={() => setOpen(true)} />
      {/* Decorative zoom affordance — the cell itself owns the click/tap. */}
      <div className="pointer-events-none absolute right-3 bottom-3 z-20 flex items-center gap-1.5 rounded-full bg-black/55 px-3 py-1.5 text-xs font-medium text-white opacity-90 backdrop-blur-sm transition-opacity group-hover:opacity-100">
        <Maximize2 className="size-3.5" />
        click image to zoom in
      </div>
      {open && (
        <MosaicZoomLightbox item={entry} onClose={() => setOpen(false)} />
      )}
    </div>
  )
}
