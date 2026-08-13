"use client"

import * as React from "react"
import { Minus, Plus, RotateCcw, X } from "lucide-react"

import { TileImageCache, type MosaicGeometry } from "@/lib/mosaic-geometry"
import type { GalleryTile } from "@/lib/gallery"
import { cn } from "@/lib/utils"

// Fullscreen pan/zoom modal that resolves a mosaic into its real source photos as
// you zoom in. The base composite (a single image) sits underneath a transformed
// wrapper; a fixed canvas overlay paints the actual photo for each on-screen tile
// once the zoom is deep enough, crossfading in so the composite→photos transition
// doesn't pop. Desktop drives it with the wheel + drag; touch with pinch + drag.
// Used by the live generator (geometry supplied in memory).

// On-screen tile size (px) at which the overlay starts/finishes fading in.
// Kept high enough that the fade window never has so many tiles on screen that
// the (pinned) working set balloons.
const REVEAL_MIN_PX = 18
const REVEAL_FULL_PX = 34
// On-screen tile size (px) past which we upgrade a tile from thumb to full-res.
const FULLRES_PX = 150
// Zoom bounds. Max is derived per-mosaic so one tile ≈ fills the viewport, capped
// here so a tiny-celled mosaic can't demand an absurd scale.
const MIN_SCALE = 1
const MAX_SCALE_CAP = 200
const MIN_MAX_SCALE = 4
const TAP_MOVE_PX = 8
// How much a single click zooms in/out toward the cursor.
const CLICK_ZOOM_FACTOR = 2

type View = { scale: number; tx: number; ty: number }
type Size = { cw: number; ch: number; dpr: number }
// Desktop click behaviour + cursor, toggled by the +/−/reset controls. Trackpad
// zoom never changes it. On touch it's irrelevant — taps never zoom there.
type CursorMode = "in" | "out" | "pointer"

const clamp = (v: number, lo: number, hi: number) =>
  v < lo ? lo : v > hi ? hi : v

// Cover-crop `img` into a `side`×`side` square centered at (cx,cy), rotated by
// `ang` — the same square-tile framing the mosaic was baked with.
function drawTile(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  cx: number,
  cy: number,
  side: number,
  ang: number
) {
  const iw = img.naturalWidth
  const ih = img.naturalHeight
  if (iw === 0 || ih === 0) return
  let sx = 0
  let sy = 0
  let sSize = iw
  if (iw > ih) {
    sSize = ih
    sx = (iw - ih) / 2
  } else if (ih > iw) {
    sSize = iw
    sy = (ih - iw) / 2
  }
  ctx.save()
  ctx.translate(cx, cy)
  if (ang) ctx.rotate(ang)
  ctx.drawImage(img, sx, sy, sSize, sSize, -side / 2, -side / 2, side, side)
  ctx.restore()
}

export function MosaicZoomViewer({
  baseSrc,
  frameW,
  frameH,
  alt = "Mosaic",
  geometry: initialGeometry,
  onClose,
}: {
  baseSrc: string
  frameW: number
  frameH: number
  alt?: string
  geometry?: MosaicGeometry | null
  onClose: () => void
}) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const wrapperRef = React.useRef<HTMLDivElement | null>(null)
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)

  const viewRef = React.useRef<View>({ scale: 1, tx: 0, ty: 0 })
  const sizeRef = React.useRef<Size>({ cw: 0, ch: 0, dpr: 1 })
  const geoRef = React.useRef<MosaicGeometry | null>(initialGeometry ?? null)
  const cacheRef = React.useRef<TileImageCache | null>(null)
  if (cacheRef.current === null) cacheRef.current = new TileImageCache()

  const rafRef = React.useRef<number | null>(null)
  const pointersRef = React.useRef<Map<number, { x: number; y: number }>>(
    new Map()
  )
  const pinchRef = React.useRef<{
    dist: number
    scale: number
    midX: number
    midY: number
    tx: number
    ty: number
  } | null>(null)
  const downRef = React.useRef<{ x: number; y: number; moved: number } | null>(
    null
  )

  const [zoomed, setZoomed] = React.useState(false)
  // Touch reveal at default zoom: dragging a finger across the un-zoomed mosaic
  // shows the source photo under it (a tooltip, like the flat-view hover) instead
  // of panning or opening a link. Cleared once the user zooms in (where the
  // canvas overlay resolves the photos itself and drag means pan).
  const [reveal, setReveal] = React.useState<{
    tile: GalleryTile
    x: number
    y: number
    // Whether to flip the tooltip to the other side of the finger so it stays on
    // screen. Computed when the reveal is set (ref reads aren't allowed in render).
    flipX: boolean
    flipY: boolean
  } | null>(null)
  // Default to "zoom in": cursor is a zoom-in glass and a click zooms into the
  // spot under it. The − button switches to "out", reset switches to "pointer".
  // Mirrored into a ref so the imperative pointer handler reads it synchronously
  // (state alone lags a render); the state still drives the cursor className.
  const [cursorMode, setCursorMode] = React.useState<CursorMode>("in")
  const cursorModeRef = React.useRef<CursorMode>("in")
  const setMode = React.useCallback((mode: CursorMode) => {
    cursorModeRef.current = mode
    setCursorMode(mode)
  }, [])

  const maxScale = React.useCallback(() => {
    const { cw, ch } = sizeRef.current
    const geo = geoRef.current
    if (!geo || cw <= 0) return 8
    // Geometry lives in the generation frame (e.g. 1600px), which maps to the
    // full container width regardless of the base image's downscaled pixels.
    const gScale = cw / geo.frameW
    const target = Math.min(cw, ch)
    const ts = geo.tileSize * gScale
    if (ts <= 0) return MIN_MAX_SCALE
    return clamp(target / ts, MIN_MAX_SCALE, MAX_SCALE_CAP)
  }, [])

  // Paint the overlay canvas in screen space for the current view. Cheap enough
  // to run per rAF: it culls to the visible tiles and only touches the canvas.
  const raster = React.useCallback(() => {
    const canvas = canvasRef.current
    const cache = cacheRef.current
    if (!canvas || !cache) return
    const { cw, ch, dpr } = sizeRef.current
    const ctx = canvas.getContext("2d")
    if (!ctx || cw === 0) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, cw, ch)

    const geo = geoRef.current
    if (!geo) return
    const { scale, tx, ty } = viewRef.current
    // Map geometry-frame coords → container px. The geometry frame fills the
    // container width, so this is independent of the (downscaled) base image.
    const gScale = cw / geo.frameW
    const tilePx = geo.tileSize * gScale * scale
    const alpha = clamp(
      (tilePx - REVEAL_MIN_PX) / (REVEAL_FULL_PX - REVEAL_MIN_PX),
      0,
      1
    )
    if (alpha <= 0) return
    ctx.globalAlpha = alpha

    const wantFull = tilePx > FULLRES_PX
    const cullR = tilePx * 0.71 + 2
    const k = scale * gScale
    // Urls on screen this pass; pinned so the cache can't evict + reload them
    // (the source of the mid-zoom flicker).
    const visible = new Set<string>()
    for (let i = 0; i < geo.count; i++) {
      const scx = tx + k * geo.cx[i]
      const scy = ty + k * geo.cy[i]
      if (
        scx < -cullR ||
        scx > cw + cullR ||
        scy < -cullR ||
        scy > ch + cullR
      ) {
        continue
      }
      const ti = geo.t[i]
      if (ti < 0) continue
      const tile = geo.tiles[ti]
      const thumb = tile.previewUrl ?? tile.url
      visible.add(thumb)
      if (wantFull) visible.add(tile.url)
      let img = wantFull ? cache.get(tile.url) : null
      if (img && wantFull) {
        // already have full-res
      } else {
        const ready = cache.get(thumb)
        if (ready) img = ready
        if (wantFull) cache.request(tile.url)
      }
      if (!img) {
        cache.request(wantFull ? tile.url : thumb)
        continue
      }
      drawTile(ctx, img, scx, scy, tilePx, geo.ang[i])
    }
    ctx.globalAlpha = 1
    cache.pin(visible)
  }, [])

  const scheduleRaster = React.useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = null
      raster()
    })
  }, [raster])

  // Push the current view to the (transformed) base wrapper immediately for
  // smoothness, and queue an overlay repaint.
  const applyView = React.useCallback(() => {
    const { scale, tx, ty } = viewRef.current
    const wrapper = wrapperRef.current
    if (wrapper) {
      wrapper.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`
    }
    scheduleRaster()
  }, [scheduleRaster])

  const clampView = React.useCallback(() => {
    const { cw, ch } = sizeRef.current
    const v = viewRef.current
    v.scale = clamp(v.scale, MIN_SCALE, maxScale())
    const minTx = cw * (1 - v.scale)
    const minTy = ch * (1 - v.scale)
    v.tx = clamp(v.tx, minTx, 0)
    v.ty = clamp(v.ty, minTy, 0)
  }, [maxScale])

  const setZoomedFlag = React.useCallback(() => {
    const z = viewRef.current.scale > 1.001
    setZoomed(z)
    // Once zoomed, the overlay resolves the photos directly — drop the default-
    // zoom reveal tooltip so it doesn't linger.
    if (z) setReveal(null)
  }, [])

  // Zoom to `nextScale` while keeping the content point under (fx,fy) fixed.
  const zoomTo = React.useCallback(
    (nextScale: number, fx: number, fy: number) => {
      const v = viewRef.current
      const ns = clamp(nextScale, MIN_SCALE, maxScale())
      v.tx = fx - (ns * (fx - v.tx)) / v.scale
      v.ty = fy - (ns * (fy - v.ty)) / v.scale
      v.scale = ns
      clampView()
      applyView()
      setZoomedFlag()
    },
    [applyView, clampView, maxScale, setZoomedFlag]
  )

  const recomputeSize = React.useCallback(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return
    const rect = container.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    sizeRef.current = { cw: rect.width, ch: rect.height, dpr }
    canvas.width = Math.round(rect.width * dpr)
    canvas.height = Math.round(rect.height * dpr)
    clampView()
    applyView()
  }, [applyView, clampView])

  // Lock background scroll, close on Escape.
  React.useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => {
      document.body.style.overflow = prev
      window.removeEventListener("keydown", onKey)
    }
  }, [onClose])

  // Measure on mount + resize.
  React.useEffect(() => {
    recomputeSize()
    const container = containerRef.current
    if (!container || typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(() => recomputeSize())
    ro.observe(container)
    return () => ro.disconnect()
  }, [recomputeSize])

  // Repaint when a requested tile image arrives.
  React.useEffect(() => {
    const cache = cacheRef.current
    if (!cache) return
    cache.onLoad = scheduleRaster
    return () => {
      cache.onLoad = null
    }
  }, [scheduleRaster])

  // Paint when in-memory geometry is already available.
  React.useEffect(() => {
    if (geoRef.current) scheduleRaster()
  }, [scheduleRaster])

  React.useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        window.cancelAnimationFrame(rafRef.current)
        // Reset the handle, not just cancel it: under React Strict Mode (dev) the
        // component unmounts and remounts on the same refs, and a stale non-null
        // handle would make scheduleRaster early-return forever — the overlay
        // would never paint.
        rafRef.current = null
      }
    }
  }, [])

  // ─── input ──────────────────────────────────────────────────────────────────

  // Find the source photo whose cell center is nearest a container-space point.
  const tileAtPoint = React.useCallback(
    (px: number, py: number): GalleryTile | null => {
      const geo = geoRef.current
      const { cw } = sizeRef.current
      if (!geo || cw <= 0) return null
      const v = viewRef.current
      const gScale = cw / geo.frameW
      const fx = (px - v.tx) / (v.scale * gScale)
      const fy = (py - v.ty) / (v.scale * gScale)
      let best = -1
      let bestD = Infinity
      const reach = geo.tileSize * 1.5
      const reach2 = reach * reach
      for (let i = 0; i < geo.count; i++) {
        if (geo.t[i] < 0) continue
        const dx = geo.cx[i] - fx
        const dy = geo.cy[i] - fy
        const d = dx * dx + dy * dy
        if (d < bestD) {
          bestD = d
          best = i
        }
      }
      if (best < 0 || bestD > reach2) return null
      return geo.tiles[geo.t[best]] ?? null
    },
    []
  )

  // Reveal the source photo under a container-space point (touch, default zoom).
  const revealAt = React.useCallback(
    (px: number, py: number) => {
      const tile = tileAtPoint(px, py)
      if (!tile) {
        setReveal(null)
        return
      }
      const { cw, ch } = sizeRef.current
      setReveal({ tile, x: px, y: py, flipX: px > cw / 2, flipY: py > ch / 2 })
    },
    [tileAtPoint]
  )

  const localPoint = (e: { clientX: number; clientY: number }) => {
    const rect = containerRef.current?.getBoundingClientRect()
    return {
      x: e.clientX - (rect?.left ?? 0),
      y: e.clientY - (rect?.top ?? 0),
    }
  }

  const onWheel = React.useCallback(
    (e: WheelEvent) => {
      e.preventDefault()
      const { x, y } = localPoint(e)
      const factor = Math.exp(-e.deltaY * 0.0015)
      zoomTo(viewRef.current.scale * factor, x, y)
    },
    [zoomTo]
  )

  // Wheel needs a non-passive native listener to call preventDefault.
  React.useEffect(() => {
    const container = containerRef.current
    if (!container) return
    container.addEventListener("wheel", onWheel, { passive: false })
    return () => container.removeEventListener("wheel", onWheel)
  }, [onWheel])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const { x, y } = localPoint(e)
    try {
      containerRef.current?.setPointerCapture(e.pointerId)
    } catch {
      // setPointerCapture throws for a non-active pointer in some browsers; the
      // gesture still works without capture.
    }
    pointersRef.current.set(e.pointerId, { x, y })
    downRef.current = { x, y, moved: 0 }
    if (pointersRef.current.size === 2) {
      setReveal(null)
      const pts = [...pointersRef.current.values()]
      const dx = pts[0].x - pts[1].x
      const dy = pts[0].y - pts[1].y
      const v = viewRef.current
      pinchRef.current = {
        dist: Math.hypot(dx, dy) || 1,
        scale: v.scale,
        midX: (pts[0].x + pts[1].x) / 2,
        midY: (pts[0].y + pts[1].y) / 2,
        tx: v.tx,
        ty: v.ty,
      }
      return
    }
    // Touch at default zoom: reveal the photo under the finger (tap or drag).
    if (e.pointerType !== "mouse" && viewRef.current.scale <= 1.001) {
      revealAt(x, y)
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const prev = pointersRef.current.get(e.pointerId)
    if (!prev) return
    const { x, y } = localPoint(e)
    const dx = x - prev.x
    const dy = y - prev.y
    pointersRef.current.set(e.pointerId, { x, y })
    if (downRef.current) {
      downRef.current.moved += Math.abs(dx) + Math.abs(dy)
    }

    if (pointersRef.current.size === 2 && pinchRef.current) {
      const pts = [...pointersRef.current.values()]
      const cdx = pts[0].x - pts[1].x
      const cdy = pts[0].y - pts[1].y
      const dist = Math.hypot(cdx, cdy) || 1
      const midX = (pts[0].x + pts[1].x) / 2
      const midY = (pts[0].y + pts[1].y) / 2
      const p = pinchRef.current
      const ns = clamp((p.scale * dist) / p.dist, MIN_SCALE, maxScale())
      const v = viewRef.current
      v.scale = ns
      // Keep the pinch's starting midpoint content under the live midpoint.
      v.tx = midX - (ns * (p.midX - p.tx)) / p.scale
      v.ty = midY - (ns * (p.midY - p.ty)) / p.scale
      clampView()
      applyView()
      setZoomedFlag()
      return
    }

    if (pointersRef.current.size === 1 && viewRef.current.scale > 1.001) {
      // Zoomed in: single-finger drag pans.
      const v = viewRef.current
      v.tx += dx
      v.ty += dy
      clampView()
      applyView()
    } else if (
      pointersRef.current.size === 1 &&
      e.pointerType !== "mouse" &&
      viewRef.current.scale <= 1.001
    ) {
      // Default zoom: single-finger drag reveals the photos under the finger.
      revealAt(x, y)
    }
  }

  const endPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const wasTap =
      downRef.current !== null && downRef.current.moved < TAP_MOVE_PX
    const { x, y } = localPoint(e)
    pointersRef.current.delete(e.pointerId)
    if (pointersRef.current.size < 2) pinchRef.current = null
    downRef.current = null
    if (!wasTap || pointersRef.current.size > 0) return

    if (e.pointerType === "mouse") {
      // Desktop: a click zooms toward the cursor in the direction of the current
      // mode (set by the +/−/reset controls). Pointer mode is a no-op. Trackpad
      // zoom leaves the mode — and so the cursor — untouched.
      const v = viewRef.current
      const mode = cursorModeRef.current
      if (mode === "in") zoomTo(v.scale * CLICK_ZOOM_FACTOR, x, y)
      else if (mode === "out") zoomTo(v.scale / CLICK_ZOOM_FACTOR, x, y)
      return
    }

    // Touch: a tap never zooms (pinch does) and never opens a link — at default
    // zoom it just reveals the photo under the finger (set on pointer down), which
    // stays visible so it can be read until the next drag, tap, or zoom.
  }

  const zoomButton = (dir: 1 | -1) => {
    const { cw, ch } = sizeRef.current
    const v = viewRef.current
    setMode(dir > 0 ? "in" : "out")
    zoomTo(v.scale * (dir > 0 ? 1.6 : 1 / 1.6), cw / 2, ch / 2)
  }

  const reset = () => {
    const v = viewRef.current
    v.scale = 1
    v.tx = 0
    v.ty = 0
    clampView()
    applyView()
    setZoomedFlag()
    setMode("pointer")
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/90 p-4 font-sans backdrop-blur-sm"
      onPointerDown={(e) => {
        // Click on the backdrop (outside the stage) closes.
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute top-4 right-4 z-20 flex size-10 items-center justify-center rounded-full bg-white/10 text-white transition-colors hover:bg-white/20"
      >
        <X className="size-5" />
      </button>

      <div
        ref={containerRef}
        className={cn(
          "relative touch-none overflow-hidden rounded-lg select-none",
          cursorMode === "in" && "cursor-zoom-in",
          cursorMode === "out" && "cursor-zoom-out",
          cursorMode === "pointer" && "cursor-default"
        )}
        style={{
          width: `min(92vw, calc(85svh * ${frameW} / ${frameH}))`,
          aspectRatio: `${frameW} / ${frameH}`,
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={(e) => {
          pointersRef.current.delete(e.pointerId)
          if (pointersRef.current.size < 2) pinchRef.current = null
          downRef.current = null
        }}
      >
        <div
          ref={wrapperRef}
          className="absolute inset-0 origin-top-left will-change-transform"
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- base composite, intrinsic-sized */}
          <img
            src={baseSrc}
            alt={alt}
            draggable={false}
            className="block size-full select-none"
          />
        </div>
        <canvas
          ref={canvasRef}
          className="pointer-events-none absolute inset-0 size-full"
        />

        {reveal && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute z-10 w-40 overflow-hidden rounded-2xl border bg-popover p-2 shadow-lg sm:w-52"
            style={{
              left: `${reveal.x}px`,
              top: `${reveal.y}px`,
              transform: `translate(${
                reveal.flipX ? "calc(-100% - 16px)" : "16px"
              }, ${reveal.flipY ? "calc(-100% - 16px)" : "16px"})`,
            }}
          >
            <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-card">
              {/* eslint-disable-next-line @next/next/no-img-element -- public library URL, shown only as a reveal preview */}
              <img
                src={reveal.tile.previewUrl ?? reveal.tile.url}
                alt={reveal.tile.title}
                draggable={false}
                className="size-full object-cover"
              />
              <span className="absolute inset-x-0 bottom-0 line-clamp-2 bg-black/70 px-2 py-1.5 text-left text-xs font-medium text-white">
                {reveal.tile.title}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="absolute bottom-[calc(env(safe-area-inset-bottom,0px)+1rem)] left-1/2 z-20 flex -translate-x-1/2 items-center gap-2">
        <div className="flex items-center gap-1 rounded-full bg-white/10 p-1 backdrop-blur">
          <button
            type="button"
            aria-label="Zoom out"
            onClick={() => zoomButton(-1)}
            className="flex size-9 items-center justify-center rounded-full text-white transition-colors hover:bg-white/20"
          >
            <Minus className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Reset zoom"
            onClick={reset}
            className="flex size-9 items-center justify-center rounded-full text-white transition-colors hover:bg-white/20"
          >
            <RotateCcw className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Zoom in"
            onClick={() => zoomButton(1)}
            className="flex size-9 items-center justify-center rounded-full text-white transition-colors hover:bg-white/20"
          >
            <Plus className="size-4" />
          </button>
        </div>
      </div>

      <p className="pointer-events-none absolute inset-x-0 top-[calc(env(safe-area-inset-top,0px)+1rem)] text-center text-sm text-white/70">
        {zoomed
          ? "Drag to look around — use the − button to zoom back out"
          : "Drag across to reveal the photos that make it up — pinch or click to zoom in"}
      </p>
    </div>
  )
}
