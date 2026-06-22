"use client"

import * as React from "react"
import Link from "next/link"
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Download,
  Lock,
  Maximize2,
  PanelRight,
  Share2,
  X,
} from "lucide-react"

import {
  loadLibrary,
  fetchLibraryVersion,
  thumbUrl,
  BUCKET_LABELS,
  BUCKET_COPY,
  MOSAIC_BUCKETS,
  type LibraryItem,
  type MosaicBucket,
} from "@/lib/photo-library"
import {
  ReferenceCard,
  ReferenceEmptyCard,
  ReferencePanelEmpty,
  makeReferenceFromFile,
  type ReferenceImage,
} from "@/components/reference-image"
import { NewYorkMosaicFormLink } from "@/components/new-york-mosaic-form-link"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { buildMosaicHitMap } from "@/lib/mosaic-hitmap"
import {
  buildMosaicGeometry,
  encodeGeometry,
  type MosaicGeometry,
} from "@/lib/mosaic-geometry"
import { MosaicZoomViewer } from "@/components/mosaic-zoom-viewer"
import type { GalleryTile } from "@/lib/gallery"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarProvider,
  SidebarSeparator,
  useSidebar,
} from "@/components/ui/sidebar"
import { Slider } from "@/components/ui/slider"
import { MosaicEngine } from "@/lib/mosaic-client"
import type { TileWeighting } from "@/lib/mosaic-protocol"
import {
  averageColor,
  edgeVectorField,
  gridForCellSize,
  loadImage,
  referenceWindowSignatures,
} from "@/lib/mosaic"
import { contourMosaic } from "@/lib/contour-mosaic"
import { cn } from "@/lib/utils"

// The mosaic renders into a flat frame matching the reference's aspect ratio so
// tiles stay square instead of stretching. The long edge is fixed so tile
// detail stays roughly constant regardless of the reference's shape.
const CANVAS_LONG_EDGE = 1600
// Long edge of the edge-vector field the contour-flow layout samples for tile
// orientation; kept coarse since it only steers direction, not color.
const FIELD_LONG_EDGE = 360

// Mosaic cell size in px (within the frame). Smaller = finer grid (more tiles,
// higher resolution). Resolution is chosen from three fixed presets below.
const DENSITY_MIN = 16
const DENSITY_MAX = 80

const RESOLUTION_MODES = {
  low: 70,
  medium: 76,
  high: 80,
} as const

type ResolutionMode = keyof typeof RESOLUTION_MODES

const RESOLUTION_MODE_ORDER: ResolutionMode[] = ["low", "medium", "high"]

function densityForResolution(resolution: number, densityMin: number) {
  return clampDensity(
    densityMin + DENSITY_MAX - resolution,
    densityMin,
    DENSITY_MAX
  )
}

function resolutionForDensity(density: number, densityMin: number) {
  return densityMin + DENSITY_MAX - density
}

function nearestResolutionMode(
  density: number,
  densityMin: number
): ResolutionMode {
  const resolution = resolutionForDensity(density, densityMin)
  let best: ResolutionMode = "medium"
  let bestDiff = Infinity
  for (const mode of RESOLUTION_MODE_ORDER) {
    const diff = Math.abs(RESOLUTION_MODES[mode] - resolution)
    if (diff < bestDiff) {
      bestDiff = diff
      best = mode
    }
  }
  return best
}

function ControlsSidebarTrigger({
  className,
  onToggle,
}: {
  className?: string
  onToggle?: () => void
}) {
  const { isMobile, open, openMobile, toggleSidebar } = useSidebar()
  const isOpen = isMobile ? openMobile : open

  return (
    <Button
      type="button"
      variant="ghost"
      size={isMobile ? "default" : "icon-sm"}
      aria-label={isOpen ? "Hide controls sidebar" : "Show controls sidebar"}
      aria-expanded={isOpen}
      className={className}
      onClick={() => {
        onToggle?.()
        toggleSidebar()
      }}
    >
      <PanelRight />
      <span className={isMobile ? "" : "sr-only"}>Controls</span>
    </Button>
  )
}

// Resolution presets + the primary Generate/Save actions. Shared between the
// desktop sidebar and the mobile bottom bar so both stay in sync.
function MosaicActionControls({
  resolutionMode,
  onSelectMode,
  onGenerate,
  isGenerating,
  hasMosaic,
  progressPct,
  generateDisabled,
  onDownload,
  showSave = true,
  showPublish = false,
  onPublish,
  isPublishing = false,
  className,
}: {
  resolutionMode: ResolutionMode
  onSelectMode: (mode: ResolutionMode) => void
  onGenerate: () => void
  isGenerating: boolean
  hasMosaic: boolean
  progressPct: number
  generateDisabled: boolean
  onDownload: () => void
  showSave?: boolean
  // Whether to surface the "Publish & share" action (shown once a mosaic
  // exists). Open to everyone; the share route enforces the rate limits.
  showPublish?: boolean
  onPublish?: () => void
  isPublishing?: boolean
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div
        className="grid grid-cols-3 gap-1"
        role="group"
        aria-label="Mosaic resolution"
      >
        {RESOLUTION_MODE_ORDER.map((mode) => (
          <Button
            key={mode}
            type="button"
            size="sm"
            variant={resolutionMode === mode ? "default" : "outline"}
            className="capitalize"
            aria-pressed={resolutionMode === mode}
            onClick={() => onSelectMode(mode)}
          >
            {mode}
          </Button>
        ))}
      </div>

      <Button onClick={() => void onGenerate()} disabled={generateDisabled}>
        {isGenerating
          ? `Generating ${progressPct.toFixed(1)}%`
          : hasMosaic
            ? "Regenerate"
            : "Generate mosaic"}
      </Button>
      {showSave && hasMosaic && (
        <Button
          variant="outline"
          onClick={() => void onDownload()}
          disabled={isGenerating}
        >
          <Download />
          Save image
        </Button>
      )}
      {showPublish && hasMosaic && (
        <Button
          variant="outline"
          onClick={() => void onPublish?.()}
          disabled={isGenerating || isPublishing}
        >
          <Share2 />
          {isPublishing ? "Publishing…" : "Publish & share"}
        </Button>
      )}
    </div>
  )
}

// Mobile-only bottom bar. Before a reference is added it's just the Controls
// trigger; once a photo is in place it surfaces the resolution presets and the
// Generate button directly so the primary action isn't buried in the sheet.
function MobileActionBar({
  hasReference,
  onToggleControls,
  ...controls
}: {
  hasReference: boolean
  onToggleControls: () => void
} & React.ComponentProps<typeof MosaicActionControls>) {
  const { isMobile, openMobile, toggleSidebar } = useSidebar()
  if (!isMobile) return null

  const openControls = () => {
    onToggleControls()
    toggleSidebar()
  }

  if (!hasReference) {
    return (
      <div className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom,0px)+1rem)] z-30 sm:inset-x-4">
        <Button
          type="button"
          variant="outline"
          aria-label="Show controls"
          aria-expanded={openMobile}
          className="h-10 w-full justify-center bg-background shadow-lg"
          onClick={openControls}
        >
          <PanelRight />
          Controls
        </Button>
      </div>
    )
  }

  // "Publish & share" rides in the mobile bottom bar too. When it's shown,
  // Save collapses to a compact icon button to make room beside it. The stacked
  // controls above suppress their own publish button so it isn't duplicated.
  const showPublish =
    Boolean(controls.showPublish) && Boolean(controls.hasMosaic)

  return (
    <div className="fixed inset-x-3 bottom-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] z-30 flex flex-col gap-2 rounded-2xl border bg-background/95 p-3 shadow-lg backdrop-blur sm:inset-x-4">
      <MosaicActionControls
        {...controls}
        showSave={false}
        showPublish={false}
      />
      <div className="flex gap-2">
        {controls.hasMosaic && (
          <Button
            variant="outline"
            size={showPublish ? "icon" : "default"}
            aria-label="Save image"
            className={showPublish ? "shrink-0" : "flex-1"}
            onClick={() => void controls.onDownload()}
            disabled={controls.isGenerating}
          >
            <Download />
            {!showPublish && "Save"}
          </Button>
        )}
        {showPublish && (
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => void controls.onPublish?.()}
            disabled={controls.isGenerating || controls.isPublishing}
          >
            <Share2 />
            {controls.isPublishing ? "Publishing…" : "Publish"}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          aria-label={openMobile ? "Hide controls" : "More controls"}
          aria-expanded={openMobile}
          className={controls.hasMosaic ? "flex-1" : "w-full"}
          onClick={openControls}
        >
          <PanelRight />
          More controls
        </Button>
      </div>
    </div>
  )
}

function CloseAdvancedWhenSidebarCloses({ onClose }: { onClose: () => void }) {
  const { isMobile, open, openMobile } = useSidebar()
  const isOpen = isMobile ? openMobile : open

  React.useEffect(() => {
    if (!isOpen) onClose()
  }, [isOpen, onClose])

  return null
}

function SidebarExpandableControls({
  id,
  label,
  open,
  onOpenChange,
  children,
}: {
  id: string
  label: string
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-3">
      {open && (
        <>
          <div id={id} className="flex flex-col gap-3">
            {children}
          </div>
          <SidebarSeparator className="mx-0" />
        </>
      )}
      <Button
        type="button"
        variant="outline"
        className="w-full justify-center"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => onOpenChange(!open)}
      >
        {label}
      </Button>
    </div>
  )
}

// Era-emphasis controls (opt-in via the `eraEmphasis` prop, used by the knicks
// collection whose tiles carry a `takenAt` date). The matcher divides color
// error by a per-tile weight = 1 + recency·2^(-ageMonths/halfLife) + playoff,
// so these tilt selection toward recent / playoff photos without overriding a
// genuinely good color match. Both at 0 ⇒ unbiased (original) matching.
const RECENCY_STRENGTH_MAX = 3
const RECENCY_STRENGTH_DEFAULT = 1
const PLAYOFF_BOOST_MAX = 4
const PLAYOFF_BOOST_DEFAULT = 1.5
const RECENCY_HALF_LIFE_MONTHS = 18
// Years whose April–June window counts as "playoffs" for the playoff boost.
const PLAYOFF_YEARS = [2025, 2026]

// Largest the displayed mosaic may grow vertically (portrait refs). On desktop,
// landscape refs are usually limited by MOSAIC_CENTER_COLUMN_MAX instead.
const MOSAIC_VIEWPORT_HEIGHT_PCT = 85
const MOSAIC_CENTER_COLUMN_MAX = "65vw"
const HOVER_FULL_IMAGE_DELAY_MS = 750

type Dims = { w: number; h: number }

const MOSAIC_CACHE_DB = "mosaic-cache"
const MOSAIC_CACHE_STORE = "generated"

type MosaicTileMap = {
  assignment: Int32Array
  centers: Float32Array
  polys: Float32Array
  offsets: Int32Array
  tileIds: string[]
  extent: number
  // Per-cell rotation + frame-space cell size, needed to build the zoom geometry.
  // Optional so a mosaic restored from an older (v2) cache still hovers; it just
  // can't zoom until regenerated.
  angles?: Float32Array
  tileSize?: number
}

type CachedMosaicBase = {
  reference: Omit<ReferenceImage, "url">
  referenceBlob: Blob
  mosaicBlob: Blob
  frame: Dims
  density: number
  bgColor: string
  savedAt: number
  // Library (manifest) version this mosaic was generated against. When the
  // library is re-seeded the version changes, so a cached render from an older
  // version is treated as stale (its tiles may no longer exist) and not shown.
  libraryVersion?: string
  // Per-generated-mosaic source-photo reuse cap used for this render. A changed
  // cap means the baked image and assignment map should regenerate.
  maxTileReuse?: number
  // Era-emphasis slider positions this render was generated with, so a restored
  // mosaic shows the controls in the state that produced it.
  recencyStrength?: number
  playoffBoost?: number
}

type CachedMosaic =
  | (CachedMosaicBase & { version: 1 })
  | (CachedMosaicBase & { version: 2; tileMap: MosaicTileMap })
  // v3 adds the zoom geometry (angles + tileSize) inside tileMap. v2 entries
  // still restore + hover; they just lack the zoom overlay until regenerated.
  | (CachedMosaicBase & { version: 3; tileMap: MosaicTileMap })

type HoveredTile = {
  cell: number
  id: string
  hoverSerial: number
  previewUrl: string
  openUrl: string
  title: string
  x: number
  y: number
  width?: number
  height?: number
}

const evenDim = (n: number) => Math.max(2, Math.round(n / 2) * 2)

const clampDensity = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value))

const formatSliderValue = (value: number) =>
  Number.isInteger(value)
    ? value.toString()
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")

// Flat mosaic frame sized to the reference's aspect, long edge = CANVAS_LONG_EDGE.
function frameDimsFor(w: number, h: number): Dims {
  const aspect = w / h
  return aspect >= 1
    ? { w: CANVAS_LONG_EDGE, h: evenDim(CANVAS_LONG_EDGE / aspect) }
    : { w: evenDim(CANVAS_LONG_EDGE * aspect), h: CANVAS_LONG_EDGE }
}

// Edge-vector field dims, matching the frame's aspect at a coarse resolution.
function fieldDimsFor(w: number, h: number): { fw: number; fh: number } {
  const aspect = w / h
  return aspect >= 1
    ? {
        fw: FIELD_LONG_EDGE,
        fh: Math.max(1, Math.round(FIELD_LONG_EDGE / aspect)),
      }
    : {
        fw: Math.max(1, Math.round(FIELD_LONG_EDGE * aspect)),
        fh: FIELD_LONG_EDGE,
      }
}

function isTypingTarget(t: EventTarget | null) {
  if (!(t instanceof HTMLElement)) return false
  return (
    t.isContentEditable ||
    t.tagName === "INPUT" ||
    t.tagName === "TEXTAREA" ||
    t.tagName === "SELECT"
  )
}

function pointInPolygon(
  x: number,
  y: number,
  polys: ArrayLike<number>,
  offsets: ArrayLike<number>,
  cell: number
) {
  const start = offsets[cell]
  const end = offsets[cell + 1]
  let inside = false
  for (let i = start, j = end - 1; i < end; j = i++) {
    const xi = polys[i * 2]
    const yi = polys[i * 2 + 1]
    const xj = polys[j * 2]
    const yj = polys[j * 2 + 1]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

function hitTestTile(map: MosaicTileMap, x: number, y: number): number {
  const n = map.centers.length / 2
  for (let i = 0; i < n; i++) {
    if (pointInPolygon(x, y, map.polys, map.offsets, i)) return i
  }
  return -1
}

function openMosaicCache(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(MOSAIC_CACHE_DB, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(MOSAIC_CACHE_STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

// The generated mosaic is cached per collection (keyed by bucket) so each one
// remembers its own last reference + render independently.
async function readCachedMosaic(key: string): Promise<CachedMosaic | null> {
  const db = await openMosaicCache()
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(MOSAIC_CACHE_STORE, "readonly")
      const req = tx.objectStore(MOSAIC_CACHE_STORE).get(key)
      req.onsuccess = () =>
        resolve((req.result as CachedMosaic | undefined) ?? null)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

async function writeCachedMosaic(
  key: string,
  cache: CachedMosaic
): Promise<void> {
  const db = await openMosaicCache()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(MOSAIC_CACHE_STORE, "readwrite")
      tx.objectStore(MOSAIC_CACHE_STORE).put(cache, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

async function clearCachedMosaic(key: string): Promise<void> {
  const db = await openMosaicCache()
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(MOSAIC_CACHE_STORE, "readwrite")
      tx.objectStore(MOSAIC_CACHE_STORE).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
  } finally {
    db.close()
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"))
}

// Sharing: the published composite is a JPEG (no alpha — the canvas already has
// the grout painted, so it's opaque), downscaled so links stay light. The hover
// hit-map is resolution-independent, so the image scale and the map are decoupled.
const SHARE_LONG_EDGE = 1200
const SHARE_JPEG_QUALITY = 0.85
const SHARE_HIT_CELL_PX = 22

function canvasToShareImage(
  canvas: HTMLCanvasElement
): Promise<{ blob: Blob; w: number; h: number } | null> {
  const scale = Math.min(
    1,
    SHARE_LONG_EDGE / Math.max(canvas.width, canvas.height)
  )
  const w = Math.max(1, Math.round(canvas.width * scale))
  const h = Math.max(1, Math.round(canvas.height * scale))
  let source: HTMLCanvasElement = canvas
  if (scale < 1) {
    const off = document.createElement("canvas")
    off.width = w
    off.height = h
    const ctx = off.getContext("2d")
    if (!ctx) return Promise.resolve(null)
    ctx.drawImage(canvas, 0, 0, w, h)
    source = off
  }
  return new Promise((resolve) =>
    source.toBlob(
      (b) => resolve(b ? { blob: b, w, h } : null),
      "image/jpeg",
      SHARE_JPEG_QUALITY
    )
  )
}

// Result dialog for the admin Publish action: the live share link with copy /
// open / native-share, or the error if publishing failed.
function ShareResultDialog({
  url,
  error,
  onClose,
}: {
  url: string | null
  error: string | null
  onClose: () => void
}) {
  const [copied, setCopied] = React.useState(false)
  const canNativeShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function"

  const copy = React.useCallback(async () => {
    if (!url) return
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard can be blocked; the user can still select the field manually.
    }
  }, [url])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Share mosaic"
        className="w-full max-w-md rounded-2xl border bg-background p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold">
            {error ? "Couldn’t publish" : "Mosaic published"}
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>

        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              Anyone with this link can view your mosaic.
            </p>
            <div className="flex gap-2">
              <Input
                readOnly
                value={url ?? ""}
                onFocus={(e) => e.currentTarget.select()}
                className="font-mono text-xs"
                aria-label="Share link"
              />
              <Button type="button" onClick={() => void copy()}>
                {copied ? <Check /> : <Copy />}
                {copied ? "Copied" : "Copy"}
              </Button>
            </div>
            <div className="flex gap-2">
              <Button asChild variant="outline" className="flex-1">
                <a href={url ?? "#"} target="_blank" rel="noopener noreferrer">
                  Open
                </a>
              </Button>
              {canNativeShare && (
                <Button
                  type="button"
                  variant="ghost"
                  className="flex-1"
                  onClick={() => void navigator.share?.({ url: url ?? "" })}
                >
                  <Share2 />
                  Share…
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// Shown when publishing is temporarily unavailable — the per-IP or global
// hourly cap tripped, or sharing isn't configured on this deployment. A soft
// "try again shortly" notice rather than a hard error.
function ShareCapacityDialog({ onClose }: { onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Sharing temporarily unavailable"
        className="w-full max-w-md rounded-2xl border bg-background p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <h2 className="text-base font-semibold">High demand</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close"
            onClick={onClose}
          >
            <X />
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          sorry we are experiencing high demand at this moment, this feature is
          currently disabled. please try again shortly!
        </p>
      </div>
    </div>
  )
}

type CanvasHeroProps = {
  // Which collection's photos power the tiles. The parent remounts CanvasHero
  // (via `key={bucket}`) when this changes, so all state resets per collection.
  bucket: MosaicBucket
  // Switch to the other collection. Optional: when omitted (e.g. a standalone
  // single-collection page), the "switch to …" control is hidden entirely.
  onSwitchBucket?: () => void
  // True when the collection the switch points to is password-gated and not yet
  // unlocked, so the link shows a lock hint (the parent prompts on click).
  switchLocked?: boolean
  // Optional cap on how many cells a single library photo may occupy in one
  // generated mosaic.
  maxTileReuse?: number
  // Smaller cells create a higher-resolution mosaic at a higher generation cost.
  minCellSize?: number
  // Enable the recency/playoff emphasis controls + match bias. Only meaningful
  // for collections whose tiles carry a `takenAt` date (the knicks library).
  eraEmphasis?: boolean
  // Hide the intro heading and description for standalone pages that only need
  // the controls and mosaic canvas.
  hideIntroCopy?: boolean
  // Hide the small current-collection label above the controls.
  hideCollectionLabel?: boolean
}

export function CanvasHero({
  bucket,
  onSwitchBucket,
  switchLocked = false,
  maxTileReuse,
  minCellSize = DENSITY_MIN,
  eraEmphasis = false,
  hideIntroCopy = false,
  hideCollectionLabel = false,
}: CanvasHeroProps) {
  const densityMin = clampDensity(minCellSize, 1, DENSITY_MAX)
  const [reference, setReference] = React.useState<ReferenceImage | null>(null)
  // Pixel dims of the mosaic frame, derived from the reference's aspect.
  const [frame, setFrame] = React.useState<Dims | null>(null)
  const [isGenerating, setIsGenerating] = React.useState(false)
  const [hasMosaic, setHasMosaic] = React.useState(false)
  // Mosaic resolution as a cell size in px; smaller cells = higher resolution.
  const [density, setDensity] = React.useState(() =>
    densityForResolution(RESOLUTION_MODES.medium, densityMin)
  )
  // Era-emphasis strengths (knicks only). Default to a gentle tilt so the bias
  // is visible out of the box; the user can drag either to 0 to compare.
  const [recencyStrength, setRecencyStrength] = React.useState(
    RECENCY_STRENGTH_DEFAULT
  )
  const [playoffBoost, setPlayoffBoost] = React.useState(PLAYOFF_BOOST_DEFAULT)
  const [showAdvanced, setShowAdvanced] = React.useState(false)
  const [generateProgress, setGenerateProgress] = React.useState<{
    done: number
    total: number
  } | null>(null)
  const [displayedProgressPct, setDisplayedProgressPct] = React.useState(0)
  // How many tile photos are available in the (cached) library.
  const [tileCount, setTileCount] = React.useState(0)
  const [tileMap, setTileMap] = React.useState<MosaicTileMap | null>(null)
  const [hoveredTile, setHoveredTile] = React.useState<HoveredTile | null>(null)
  // Whether a mouse is currently over the mosaic. Drives the "click image to zoom
  // in" badge: it shows only when the cursor is off the image (and always on
  // touch, where there's no hover), so it never flickers as the cursor moves
  // between cells the way `hoveredTile` does.
  const [pointerOverImage, setPointerOverImage] = React.useState(false)
  const [fullHoverTileKey, setFullHoverTileKey] = React.useState<string | null>(
    null
  )
  // "Publish & share" state.
  const [isPublishing, setIsPublishing] = React.useState(false)
  const [shareUrl, setShareUrl] = React.useState<string | null>(null)
  const [shareError, setShareError] = React.useState<string | null>(null)
  // Shown when publishing is temporarily unavailable (per-IP / global hourly
  // cap tripped, or sharing not configured) — a soft "try again" notice.
  const [shareCapacityNotice, setShareCapacityNotice] = React.useState(false)

  const mosaicCanvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const bgColorRef = React.useRef<string>("#ffffff")
  const engineRef = React.useRef<MosaicEngine | null>(null)
  const referenceBlobRef = React.useRef<Blob | null>(null)
  const hoverSerialRef = React.useRef(0)
  // Remember the last pointer type so touch interactions reveal tiles by
  // dragging (like the home gallery) instead of opening the source image.
  const pointerTypeRef = React.useRef<string>("mouse")
  // Start point of a touch on the flat mosaic, used to tell a tap (which opens
  // the zoom preview, like the home/view pages) from a drag (a scroll — ignored).
  const tapStartRef = React.useRef<{ x: number; y: number } | null>(null)
  const [restoredMosaicUrl, setRestoredMosaicUrl] = React.useState<
    string | null
  >(null)
  // Ids of the tile photos (from the shared library) used for matching.
  const tileIdsRef = React.useRef<string[]>([])
  // Library items by id — state (not a ref) so the usage stats below recompute
  // once the library finishes loading.
  const [libraryById, setLibraryById] = React.useState<
    Map<string, LibraryItem>
  >(() => new Map())
  // Version of the loaded library, stamped into the cache so a re-seed makes a
  // previously generated (and cached) mosaic regenerate instead of restoring.
  const libraryVersionRef = React.useRef<string>("")
  // Mirror density into a ref so handleGenerate stays stable yet reads the
  // latest value when the user explicitly generates.
  const densityRef = React.useRef(density)
  React.useEffect(() => {
    densityRef.current = density
  }, [density])
  // Mirror the emphasis sliders into refs for the same reason.
  const recencyStrengthRef = React.useRef(recencyStrength)
  const playoffBoostRef = React.useRef(playoffBoost)
  React.useEffect(() => {
    recencyStrengthRef.current = recencyStrength
  }, [recencyStrength])
  React.useEffect(() => {
    playoffBoostRef.current = playoffBoost
  }, [playoffBoost])

  const targetProgressPct =
    generateProgress && generateProgress.total > 0
      ? Math.min(100, (generateProgress.done / generateProgress.total) * 100)
      : isGenerating
        ? 0
        : null

  React.useEffect(() => {
    if (targetProgressPct === null) {
      return
    }

    const timer = window.setInterval(() => {
      setDisplayedProgressPct((current) => {
        const delta = targetProgressPct - current
        if (Math.abs(delta) < 0.1) {
          return targetProgressPct
        }
        return current + delta * 0.16
      })
    }, 33)
    return () => window.clearInterval(timer)
  }, [targetProgressPct])

  // Monotonic token so a superseded generate is discarded.
  const generateTokenRef = React.useRef(0)

  // Spin up the mosaic worker once on mount and hydrate it with the shared photo
  // library from Supabase (signatures + thumbnail URLs). The worker owns tile
  // matching and base-canvas rendering off the main thread, fetching thumbnails
  // lazily for placed tiles.
  React.useEffect(() => {
    let cancelled = false
    const engine = new MosaicEngine()
    engineRef.current = engine
    void (async () => {
      const { version, items } = await loadLibrary(bucket)
      if (cancelled || items.length === 0) return
      libraryVersionRef.current = version
      engine.hydrate(items)
      tileIdsRef.current = items.map((it) => it.id)
      setLibraryById(new Map(items.map((it) => [it.id, it])))
      setTileCount(items.length)
    })()
    return () => {
      cancelled = true
      engine.terminate()
      engineRef.current = null
    }
  }, [bucket, maxTileReuse])

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const cached = await readCachedMosaic(bucket)
        if (cancelled || !cached) return
        // If the library was re-seeded since this mosaic was generated, the baked
        // render can contain tiles that no longer exist — keep the reference so
        // the user can regenerate, but don't show the stale image.
        const currentVersion = await fetchLibraryVersion(bucket)
        if (cancelled) return
        const stale =
          (currentVersion !== null &&
            cached.libraryVersion !== currentVersion) ||
          cached.maxTileReuse !== maxTileReuse

        const referenceUrl = URL.createObjectURL(cached.referenceBlob)
        referenceBlobRef.current = cached.referenceBlob
        bgColorRef.current = cached.bgColor
        setReference({ ...cached.reference, url: referenceUrl })
        setFrame(cached.frame)
        setDensity(
          densityForResolution(
            RESOLUTION_MODES[nearestResolutionMode(cached.density, densityMin)],
            densityMin
          )
        )
        if (eraEmphasis) {
          if (typeof cached.recencyStrength === "number") {
            setRecencyStrength(cached.recencyStrength)
          }
          if (typeof cached.playoffBoost === "number") {
            setPlayoffBoost(cached.playoffBoost)
          }
        }
        setHoveredTile(null)

        if (stale) {
          setHasMosaic(false)
          setTileMap(null)
          setRestoredMosaicUrl(null)
          return
        }

        setHasMosaic(true)
        setTileMap(
          cached.version === 2 || cached.version === 3 ? cached.tileMap : null
        )
        setRestoredMosaicUrl(URL.createObjectURL(cached.mosaicBlob))
      } catch {
        // Cache access is best-effort; the app still works without persistence.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [bucket, maxTileReuse, densityMin, eraEmphasis])

  const referenceRef = React.useRef<ReferenceImage | null>(null)
  React.useEffect(() => {
    referenceRef.current = reference
  }, [reference])
  React.useEffect(() => {
    return () => {
      if (referenceRef.current) URL.revokeObjectURL(referenceRef.current.url)
    }
  }, [])

  const hoveredTileKey = hoveredTile
    ? `${hoveredTile.hoverSerial}:${hoveredTile.cell}:${hoveredTile.id}:${hoveredTile.previewUrl}`
    : null

  React.useEffect(() => {
    if (!hoveredTile || !hoveredTileKey) return
    if (hoveredTile.openUrl === hoveredTile.previewUrl) return
    const timer = window.setTimeout(() => {
      setFullHoverTileKey(hoveredTileKey)
    }, HOVER_FULL_IMAGE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [hoveredTile, hoveredTileKey])

  const showFullHoverImage =
    hoveredTileKey !== null && fullHoverTileKey === hoveredTileKey

  // Resolve a library id into the GalleryTile shown in hover/zoom. Shared by the
  // publish hit-map, the published zoom geometry, and the live zoom overlay so
  // all three point at identical urls.
  const resolveTile = React.useCallback(
    (id: string): GalleryTile => {
      const item = libraryById.get(id)
      return {
        url: item?.fullUrl ?? item?.url ?? thumbUrl(bucket, id),
        previewUrl: item?.url ?? thumbUrl(bucket, id),
        title: item?.galleryTitle ?? item?.gallery ?? id,
      }
    },
    [libraryById, bucket]
  )

  // Zoom explorer state. Opening snapshots the current canvas as the base image
  // and builds the in-memory geometry so the overlay can repaint the real photos.
  const [zoomState, setZoomState] = React.useState<{
    baseSrc: string
    geometry: MosaicGeometry | null
  } | null>(null)

  const openZoom = React.useCallback(() => {
    const canvas = mosaicCanvasRef.current
    const map = tileMap
    const fr = frame
    if (!canvas || !fr || !hasMosaic) return
    const baseSrc = canvas.toDataURL("image/jpeg", 0.9)
    const geometry =
      map && map.angles && map.tileSize
        ? buildMosaicGeometry({
            frameW: fr.w,
            frameH: fr.h,
            tileSize: map.tileSize,
            centers: map.centers,
            angles: map.angles,
            assignment: map.assignment,
            tileIds: map.tileIds,
            resolveTile,
          })
        : null
    setZoomState({ baseSrc, geometry })
  }, [tileMap, frame, hasMosaic, resolveTile])

  const handleSetReference = React.useCallback(
    async (file: File) => {
      try {
        const next = await makeReferenceFromFile(file)
        generateTokenRef.current++
        referenceBlobRef.current = file
        setReference((prev) => {
          if (prev) URL.revokeObjectURL(prev.url)
          return next
        })
        setFrame(frameDimsFor(next.width, next.height))
        setHasMosaic(false)
        setTileMap(null)
        setHoveredTile(null)
        setIsGenerating(false)
        setGenerateProgress(null)
        setRestoredMosaicUrl(null)
        void clearCachedMosaic(bucket)
      } catch {
        // Unreadable image — keep current state so the user can retry.
      }
    },
    [bucket]
  )

  const handleRemoveReference = React.useCallback(() => {
    generateTokenRef.current++
    setReference((prev) => {
      if (prev) URL.revokeObjectURL(prev.url)
      return null
    })
    referenceBlobRef.current = null
    setFrame(null)
    setHasMosaic(false)
    setTileMap(null)
    setHoveredTile(null)
    setIsGenerating(false)
    setGenerateProgress(null)
    setRestoredMosaicUrl(null)
    void clearCachedMosaic(bucket)
  }, [bucket])

  // Generate the contour-flow mosaic and paint it into the canvas. The raw tiles
  // sit on the reference's average color (the grout) showing through the gaps.
  const handleGenerate = React.useCallback(async () => {
    const ref = referenceRef.current
    const engine = engineRef.current
    if (!ref || !engine) return
    const ids = tileIdsRef.current
    if (ids.length === 0) return
    const { w: canvasW, h: canvasH } = frameDimsFor(ref.width, ref.height)
    const token = ++generateTokenRef.current
    setIsGenerating(true)
    setGenerateProgress(null)
    setDisplayedProgressPct(0)
    setRestoredMosaicUrl(null)
    setTileMap(null)
    setHoveredTile(null)
    // Paint the grout color then the worker frame on top; the frame is
    // transparent between tiles, so the grout shows in the gaps.
    const blit = (bitmap: ImageBitmap) => {
      const ctx = mosaicCanvasRef.current?.getContext("2d")
      if (!ctx) return
      ctx.clearRect(0, 0, canvasW, canvasH)
      ctx.fillStyle = bgColorRef.current
      ctx.fillRect(0, 0, canvasW, canvasH)
      ctx.drawImage(bitmap, 0, 0)
    }
    try {
      const refImg = await loadImage(ref.url)
      bgColorRef.current = averageColor(refImg)
      const cellSize = densityRef.current
      const grid = gridForCellSize(cellSize, canvasW, canvasH)
      const { fw, fh } = fieldDimsFor(canvasW, canvasH)
      const vfield = edgeVectorField(refImg, fw, fh)
      const cm = contourMosaic(canvasW, canvasH, cellSize, vfield)
      const cellSigs = referenceWindowSignatures(
        refImg,
        cm.centers,
        cm.tileSize,
        canvasW,
        canvasH
      )
      // Era bias is opt-in (knicks). Build it from the live slider refs so the
      // matcher favors recent/playoff tiles; omitted entirely otherwise.
      const weighting: TileWeighting | undefined = eraEmphasis
        ? {
            recencyStrength: recencyStrengthRef.current,
            playoffBoost: playoffBoostRef.current,
            recencyHalfLifeMonths: RECENCY_HALF_LIFE_MONTHS,
            playoffYears: PLAYOFF_YEARS,
          }
        : undefined
      const { assignment, base } = await engine.generate(
        cellSigs,
        grid,
        ids,
        cm.angles,
        cm.polys,
        cm.offsets,
        canvasW,
        canvasH,
        (bitmap) => {
          if (token !== generateTokenRef.current) {
            bitmap.close()
            return
          }
          blit(bitmap)
          bitmap.close()
        },
        (doneCells, totalCells) => {
          if (token !== generateTokenRef.current) return
          setGenerateProgress({ done: doneCells, total: totalCells })
        },
        { maxTileReuse, weighting }
      )
      if (token !== generateTokenRef.current) {
        base.close()
        return
      }
      blit(base)
      base.close()
      const nextTileMap: MosaicTileMap = {
        assignment,
        centers: cm.centers,
        polys: cm.polys,
        offsets: cm.offsets,
        tileIds: [...ids],
        extent: cm.extent,
        angles: cm.angles,
        tileSize: cm.tileSize,
      }
      setTileMap(nextTileMap)
      setHasMosaic(true)
      const canvas = mosaicCanvasRef.current
      const referenceBlob = referenceBlobRef.current
      if (canvas && referenceBlob) {
        void (async () => {
          try {
            const mosaicBlob = await canvasToBlob(canvas)
            if (
              !mosaicBlob ||
              token !== generateTokenRef.current ||
              referenceBlob !== referenceBlobRef.current
            ) {
              return
            }
            await writeCachedMosaic(bucket, {
              version: 3,
              reference: {
                name: ref.name,
                width: ref.width,
                height: ref.height,
              },
              referenceBlob,
              mosaicBlob,
              frame: { w: canvasW, h: canvasH },
              density: cellSize,
              bgColor: bgColorRef.current,
              tileMap: nextTileMap,
              savedAt: Date.now(),
              libraryVersion: libraryVersionRef.current,
              maxTileReuse,
              recencyStrength: eraEmphasis
                ? recencyStrengthRef.current
                : undefined,
              playoffBoost: eraEmphasis ? playoffBoostRef.current : undefined,
            })
          } catch {
            // Quota/private-mode failures should not block the generated mosaic.
          }
        })()
      }
    } catch {
      // Generation failed — keep the prior canvas.
    } finally {
      if (token === generateTokenRef.current) {
        setIsGenerating(false)
        setGenerateProgress(null)
      }
    }
  }, [bucket, maxTileReuse, eraEmphasis])

  // Export the current mosaic canvas as a downloaded PNG. The canvas is never
  // tainted (tiles are fetched with CORS — the same toBlob path backs the
  // generated-mosaic cache), so toBlob succeeds at full frame resolution.
  const handleDownload = React.useCallback(async () => {
    const canvas = mosaicCanvasRef.current
    if (!canvas || !hasMosaic) return
    try {
      const blob = await canvasToBlob(canvas)
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const base = reference?.name.replace(/\.[^./\\]+$/, "").trim() || bucket
      const a = document.createElement("a")
      a.href = url
      a.download = `${base}-mosaic.png`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      // Download is best-effort; failure leaves the on-screen mosaic intact.
    }
  }, [hasMosaic, reference, bucket])

  // Publish the current mosaic to a shareable /m/<id> link. Builds the same
  // hover hit-map the gallery uses, captures the canvas as a JPEG, and posts
  // both to the share route, which persists them and returns the link.
  const handlePublish = React.useCallback(async () => {
    const canvas = mosaicCanvasRef.current
    const map = tileMap
    const fr = frame
    if (!canvas || !map || !fr || !hasMosaic || isPublishing) return
    setIsPublishing(true)
    setShareError(null)
    setShareUrl(null)
    setShareCapacityNotice(false)
    try {
      const hit = buildMosaicHitMap({
        frameW: fr.w,
        frameH: fr.h,
        centers: map.centers,
        assignment: map.assignment,
        tileIds: map.tileIds,
        hitCellPx: SHARE_HIT_CELL_PX,
        resolveTile,
      })
      const shot = await canvasToShareImage(canvas)
      if (!shot) throw new Error("Could not capture the mosaic image.")

      const fd = new FormData()
      fd.append("image", shot.blob, "mosaic.jpg")
      fd.append("tilemap", JSON.stringify({ w: shot.w, h: shot.h, ...hit }))
      // Per-tile zoom geometry. Resolution-independent (frame coords), so the
      // downscaled share image and the geometry stay decoupled. Omitted when an
      // older cached mosaic lacks angles — it still publishes + hovers.
      if (map.angles && map.tileSize) {
        const geometry = buildMosaicGeometry({
          frameW: fr.w,
          frameH: fr.h,
          tileSize: map.tileSize,
          centers: map.centers,
          angles: map.angles,
          assignment: map.assignment,
          tileIds: map.tileIds,
          resolveTile,
        })
        fd.append("geometry", JSON.stringify(encodeGeometry(geometry)))
      }
      fd.append("collection", bucket)
      fd.append("w", String(shot.w))
      fd.append("h", String(shot.h))

      const res = await fetch("/api/mosaic/share", {
        method: "POST",
        body: fd,
      })
      // 429 (per-IP or global hourly cap) and 503 (capacity / not configured)
      // are temporary: show the soft "high demand" notice, not a hard error.
      if (res.status === 429 || res.status === 503) {
        setShareCapacityNotice(true)
        return
      }
      if (!res.ok) {
        throw new Error(`Publish failed (${res.status}).`)
      }
      const { url } = (await res.json()) as { url: string }
      setShareUrl(new URL(url, window.location.origin).toString())
    } catch (err) {
      setShareError(err instanceof Error ? err.message : "Publish failed.")
    } finally {
      setIsPublishing(false)
    }
  }, [tileMap, frame, hasMosaic, isPublishing, resolveTile, bucket])

  React.useEffect(() => {
    if (!restoredMosaicUrl || !frame) return
    let cancelled = false
    const img = new Image()
    img.onload = () => {
      if (!cancelled) {
        const ctx = mosaicCanvasRef.current?.getContext("2d")
        if (ctx) {
          ctx.clearRect(0, 0, frame.w, frame.h)
          ctx.drawImage(img, 0, 0, frame.w, frame.h)
        }
        setRestoredMosaicUrl(null)
      }
      URL.revokeObjectURL(restoredMosaicUrl)
    }
    img.onerror = () => {
      if (!cancelled) setRestoredMosaicUrl(null)
      URL.revokeObjectURL(restoredMosaicUrl)
    }
    img.src = restoredMosaicUrl
    return () => {
      cancelled = true
      img.onload = null
      img.onerror = null
      URL.revokeObjectURL(restoredMosaicUrl)
    }
  }, [restoredMosaicUrl, frame])

  // Paste an image from the clipboard to set or replace the reference.
  React.useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      if (isTypingTarget(e.target)) return
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile()
          if (file) {
            e.preventDefault()
            void handleSetReference(file)
            break
          }
        }
      }
    }
    window.addEventListener("paste", onPaste)
    return () => window.removeEventListener("paste", onPaste)
  }, [handleSetReference])

  // Clear the mosaic canvas whenever there's no current mosaic (e.g. after the
  // reference changes), so the frame is blank until the next generate.
  React.useEffect(() => {
    if (hasMosaic) return
    const canvas = mosaicCanvasRef.current
    const ctx = canvas?.getContext("2d")
    if (canvas && ctx) ctx.clearRect(0, 0, canvas.width, canvas.height)
  }, [hasMosaic, reference])

  const tileFromPointer = React.useCallback(
    (
      e: React.PointerEvent<HTMLDivElement> | React.MouseEvent<HTMLDivElement>
    ): HoveredTile | null => {
      if (!hasMosaic || !frame || !tileMap) return null
      const rect = e.currentTarget.getBoundingClientRect()
      const x = ((e.clientX - rect.left) / rect.width) * frame.w
      const y = ((e.clientY - rect.top) / rect.height) * frame.h
      if (x < 0 || x > frame.w || y < 0 || y > frame.h) return null

      const cell = hitTestTile(tileMap, x, y)
      if (cell < 0) return null
      const id = tileMap.tileIds[tileMap.assignment[cell]]
      if (!id) return null
      const item = libraryById.get(id)
      const previewUrl = item?.url ?? thumbUrl(bucket, id)
      return {
        cell,
        id,
        hoverSerial: 0,
        previewUrl,
        openUrl: item?.fullUrl ?? previewUrl,
        title: item?.galleryTitle ?? item?.gallery ?? id,
        x,
        y,
        width: item?.w,
        height: item?.h,
      }
    },
    [frame, hasMosaic, tileMap, bucket, libraryById]
  )

  // Desktop hover reveals the tile under the cursor (a tooltip preview). Touch
  // has no hover: on the generate page a tap opens the zoom preview (matching the
  // home/view pages), so there is no inline reveal there.
  const handleTilePointerMove = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      pointerTypeRef.current = e.pointerType
      if (e.pointerType !== "mouse") return
      const next = tileFromPointer(e)
      setHoveredTile((prev) => {
        if (!next) return prev === null ? prev : null
        if (prev?.cell === next.cell && prev.previewUrl === next.previewUrl) {
          return prev
        }
        return { ...next, hoverSerial: ++hoverSerialRef.current }
      })
    },
    [tileFromPointer]
  )

  // Touch: remember where the finger went down so pointer-up can tell a tap
  // (opens the zoom preview) from a drag (a scroll — ignored).
  const handleTilePointerDown = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      pointerTypeRef.current = e.pointerType
      if (e.pointerType === "mouse") return
      tapStartRef.current = { x: e.clientX, y: e.clientY }
    },
    []
  )

  // A touch tap (the finger barely moved) opens the zoom preview — the same
  // pan/pinch/reveal explorer the home and view pages open on tap.
  const handleTilePointerUp = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (e.pointerType === "mouse") return
      const start = tapStartRef.current
      tapStartRef.current = null
      if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) < 12) {
        openZoom()
      }
    },
    [openZoom]
  )

  const handleTileClick = React.useCallback(() => {
    // Desktop: clicking anywhere on the mosaic opens the zoom preview (matching
    // the published mosaics). Touch is handled on pointer up so a drag/scroll is
    // not mistaken for a tap.
    if (pointerTypeRef.current !== "mouse") return
    openZoom()
  }, [openZoom])

  // Usage stats for the current mosaic: how many distinct library photos ended
  // up placed, and — for frame-sampled collections (knicks) — how many distinct
  // source clips those photos came from. Null clips means the library carries
  // no source-video info (regular photo collections), so the count is hidden.
  const mosaicStats = React.useMemo(() => {
    if (!tileMap) return null
    const photoIds = new Set<string>()
    for (let i = 0; i < tileMap.assignment.length; i++) {
      const id = tileMap.tileIds[tileMap.assignment[i]]
      if (id) photoIds.add(id)
    }
    const clips = new Set<string>()
    let withVideo = 0
    for (const id of photoIds) {
      const video = libraryById.get(id)?.video
      if (video) {
        clips.add(video)
        withVideo++
      }
    }
    return {
      cells: tileMap.assignment.length,
      uniquePhotos: photoIds.size,
      uniqueClips: withVideo > 0 ? clips.size : null,
    }
  }, [tileMap, libraryById])

  const otherBucket = MOSAIC_BUCKETS.find((b) => b !== bucket) ?? bucket
  const currentLabel = BUCKET_LABELS[bucket]
  const otherLabel = BUCKET_LABELS[otherBucket]
  const copy = BUCKET_COPY[bucket]
  const resolutionValue = resolutionForDensity(density, densityMin)
  const resolutionMode = nearestResolutionMode(density, densityMin)
  const closeAdvanced = React.useCallback(() => setShowAdvanced(false), [])
  const handleSelectResolution = React.useCallback(
    (mode: ResolutionMode) =>
      setDensity(densityForResolution(RESOLUTION_MODES[mode], densityMin)),
    [densityMin]
  )

  return (
    <SidebarProvider
      defaultOpen
      style={{ "--sidebar-width": "18rem" } as React.CSSProperties}
    >
      <CloseAdvancedWhenSidebarCloses onClose={closeAdvanced} />

      {(shareUrl || shareError) && (
        <ShareResultDialog
          url={shareUrl}
          error={shareError}
          onClose={() => {
            setShareUrl(null)
            setShareError(null)
          }}
        />
      )}

      {shareCapacityNotice && (
        <ShareCapacityDialog
          onClose={() => setShareCapacityNotice(false)}
        />
      )}

      {zoomState && frame && (
        <MosaicZoomViewer
          baseSrc={zoomState.baseSrc}
          frameW={frame.w}
          frameH={frame.h}
          alt="Your mosaic"
          geometry={zoomState.geometry}
          onClose={() => setZoomState(null)}
        />
      )}

      <section className="relative min-h-svh min-w-0 flex-1 overflow-x-hidden bg-background select-none xl:h-svh xl:overflow-hidden">
        {/* Desktop: a compact icon trigger in the corner. */}
        <ControlsSidebarTrigger
          onToggle={closeAdvanced}
          className="absolute top-6 right-6 z-30 hidden size-7 md:flex xl:top-8 xl:right-8"
        />

        {/* Mobile: a bottom bar that surfaces Generate directly once a photo
            is added, instead of hiding it behind the Controls sheet. */}
        <MobileActionBar
          hasReference={Boolean(reference)}
          onToggleControls={closeAdvanced}
          resolutionMode={resolutionMode}
          onSelectMode={handleSelectResolution}
          onGenerate={handleGenerate}
          isGenerating={isGenerating}
          hasMosaic={hasMosaic}
          progressPct={displayedProgressPct}
          generateDisabled={tileCount === 0 || isGenerating}
          onDownload={handleDownload}
          showPublish
          onPublish={handlePublish}
          isPublishing={isPublishing}
        />

        <div
          className={cn(
            "box-border grid min-h-svh w-full grid-cols-1 gap-8 px-3 py-4 max-md:flex max-md:flex-col max-md:gap-0 max-md:pt-[calc(env(safe-area-inset-top,0px)+1rem+1.5rem+1rem)] sm:px-4 md:p-6 xl:h-svh xl:[grid-template-columns:minmax(0,1fr)_minmax(0,var(--mosaic-col-max))_minmax(0,1fr)] xl:items-stretch xl:gap-8 xl:p-8",
            // Reserve room for the fixed mobile bottom bar: a tall control bar
            // once a reference exists, just the Controls button before that.
            reference
              ? "max-md:pb-[calc(env(safe-area-inset-bottom,0px)+11rem)]"
              : "max-md:pb-[calc(env(safe-area-inset-bottom,0px)+4.5rem)]"
          )}
          style={
            {
              "--mosaic-col-max": MOSAIC_CENTER_COLUMN_MAX,
            } as React.CSSProperties
          }
        >
          <div className="z-20 flex min-w-0 items-start justify-between gap-3 max-md:absolute max-md:inset-x-3 max-md:top-[calc(env(safe-area-inset-top,0px)+1rem)] sm:max-md:inset-x-4 md:flex-col md:justify-start">
            <Button variant="link" asChild className="h-auto p-0 underline">
              <Link href="/">
                <ArrowLeft />
                back to home
              </Link>
            </Button>

            {/* Mobile-only shortcut to the collaborative NYC mosaic; on desktop
                this link lives in the right sidebar instead. */}
            <Button
              variant="link"
              asChild
              className="h-auto p-0 underline md:hidden"
            >
              <NewYorkMosaicFormLink source="canvas-mobile">
                new york city mosaic
                <ArrowRight />
              </NewYorkMosaicFormLink>
            </Button>
          </div>

          <div className="mx-auto grid w-full min-w-0 place-items-center max-md:flex max-md:flex-1 max-md:items-center max-md:justify-center md:max-w-[94vw] xl:max-w-none">
            {/* The flat mosaic, centered in the dominant middle column. */}
            {reference && frame ? (
              <div
                className={cn(
                  "relative w-full",
                  hasMosaic && "cursor-pointer touch-manipulation"
                )}
                style={{
                  maxWidth: `calc(${MOSAIC_VIEWPORT_HEIGHT_PCT}svh * ${frame.w} / ${frame.h})`,
                  aspectRatio: `${frame.w} / ${frame.h}`,
                }}
                onPointerEnter={(e) => {
                  if (e.pointerType === "mouse") setPointerOverImage(true)
                }}
                onPointerDown={handleTilePointerDown}
                onPointerMove={handleTilePointerMove}
                onPointerUp={handleTilePointerUp}
                onPointerCancel={() => {
                  tapStartRef.current = null
                }}
                onPointerLeave={() => {
                  tapStartRef.current = null
                  setHoveredTile(null)
                  setPointerOverImage(false)
                }}
                onClick={handleTileClick}
              >
                <canvas
                  ref={mosaicCanvasRef}
                  width={frame.w}
                  height={frame.h}
                  className="absolute inset-0 block size-full"
                />
                {hoveredTile && hasMosaic && (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute z-10 w-56 overflow-hidden rounded-2xl border bg-popover p-2 shadow-lg"
                    style={{
                      left: `${(hoveredTile.x / frame.w) * 100}%`,
                      top: `${(hoveredTile.y / frame.h) * 100}%`,
                      transform: `translate(${
                        hoveredTile.x > frame.w * 0.5
                          ? "calc(-100% - 12px)"
                          : "12px"
                      }, ${
                        hoveredTile.y > frame.h * 0.5
                          ? "calc(-100% - 12px)"
                          : "12px"
                      })`,
                    }}
                  >
                    <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-card">
                      {/* eslint-disable-next-line @next/next/no-img-element -- public library URL, shown only as a hover preview */}
                      <img
                        src={
                          showFullHoverImage
                            ? hoveredTile.openUrl
                            : hoveredTile.previewUrl
                        }
                        alt={hoveredTile.title}
                        draggable={false}
                        className="size-full object-contain"
                      />
                      <span className="absolute inset-x-0 bottom-0 line-clamp-2 bg-black/70 px-2 py-1.5 text-left text-xs font-medium text-[var(--cream)]">
                        {hoveredTile.title}
                      </span>
                    </div>
                    <div className="mt-2 px-1 text-xs text-muted-foreground">
                      <span className="text-muted-foreground">
                        click to zoom in
                      </span>
                    </div>
                  </div>
                )}
                {/* Decorative hint only — the image itself owns the gesture
                    (click to zoom on desktop, pinch to zoom on touch), so this
                    must never intercept taps/drags meant for tile reveal. */}
                {hasMosaic && !pointerOverImage && (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute right-3 bottom-3 z-20 flex items-center gap-1.5 rounded-full bg-black/55 px-3 py-1.5 text-xs font-medium text-white opacity-90 backdrop-blur-sm"
                  >
                    <Maximize2 className="size-3.5" />
                    click image to zoom in
                  </div>
                )}
                {!hasMosaic && !isGenerating && (
                  <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5 text-center text-sm leading-tight text-muted-foreground">
                    <span className="font-medium text-foreground">
                      image added!
                    </span>
                    <span>press generate</span>
                  </div>
                )}
              </div>
            ) : (
              <ReferenceEmptyCard onSelect={handleSetReference} />
            )}
          </div>
        </div>

      </section>

      <Sidebar side="right" mobileSide="bottom" collapsible="offcanvas">
        <SidebarContent className="gap-4 p-4">
          {(!hideCollectionLabel || onSwitchBucket) && (
            <SidebarGroup className="p-0">
              <SidebarGroupContent className="flex items-center gap-2 text-sm text-muted-foreground">
                {!hideCollectionLabel && <span>{currentLabel}</span>}
                {onSwitchBucket && (
                  <>
                    {!hideCollectionLabel && <span aria-hidden="true">·</span>}
                    <Button
                      variant="link"
                      onClick={onSwitchBucket}
                      className="h-auto gap-1 p-0 underline"
                    >
                      {switchLocked && (
                        <Lock className="size-3" aria-hidden="true" />
                      )}
                      switch to {otherLabel}
                    </Button>
                  </>
                )}
              </SidebarGroupContent>
            </SidebarGroup>
          )}

          {!hideIntroCopy && (
            <SidebarGroup className="gap-3 p-0">
              <h1 className="text-2xl font-semibold tracking-tight text-balance text-foreground">
                {copy.heading}
              </h1>
              <p className="text-sm leading-relaxed text-pretty text-muted-foreground">
                {copy.description}
              </p>
            </SidebarGroup>
          )}

          {(!hideCollectionLabel || onSwitchBucket || !hideIntroCopy) && (
            <SidebarSeparator className="mx-0" />
          )}

          <SidebarGroup className="gap-3 p-0">
            <SidebarGroupLabel className="h-auto px-0 text-sm text-muted-foreground">
              Reference
            </SidebarGroupLabel>
            <SidebarGroupContent>
              {reference ? (
                <ReferenceCard
                  reference={reference}
                  onReplace={handleSetReference}
                  onRemove={handleRemoveReference}
                />
              ) : (
                <ReferencePanelEmpty onSelect={handleSetReference} />
              )}
            </SidebarGroupContent>
          </SidebarGroup>

          {reference && <SidebarSeparator className="mx-0 hidden md:block" />}

          {reference && (
            <SidebarGroup className="hidden gap-3 p-0 md:flex">
              <SidebarGroupLabel className="h-auto px-0 text-sm text-muted-foreground">
                Resolution
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <MosaicActionControls
                  resolutionMode={resolutionMode}
                  onSelectMode={handleSelectResolution}
                  onGenerate={handleGenerate}
                  isGenerating={isGenerating}
                  hasMosaic={hasMosaic}
                  progressPct={displayedProgressPct}
                  generateDisabled={tileCount === 0 || isGenerating}
                  onDownload={handleDownload}
                  showPublish
                  onPublish={handlePublish}
                  isPublishing={isPublishing}
                />
              </SidebarGroupContent>
            </SidebarGroup>
          )}

          <SidebarSeparator className="mx-0 hidden md:block" />

          {/* Invite visitors from this personal-mosaic experiment over to the
              collaborative New York mosaic. */}
          <SidebarGroup className="hidden p-0 md:flex">
            <SidebarGroupContent>
              <NewYorkMosaicFormLink
                source="canvas-sidebar"
                className="group/contribute inline-flex items-center gap-1.5 text-sm text-muted-foreground underline underline-offset-4 transition-colors hover:text-foreground"
              >
                contribute to the world&apos;s largest new york city mosaic
                <ArrowRight className="size-4 shrink-0 transition-transform duration-200 group-hover/contribute:translate-x-0.5" />
              </NewYorkMosaicFormLink>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter className="mt-auto flex flex-col gap-3 border-t p-4">
          <SidebarExpandableControls
            id="mosaic-advanced-controls"
            label="Advanced"
            open={showAdvanced}
            onOpenChange={setShowAdvanced}
          >
            {hasMosaic && mosaicStats && (
              <p className="text-xs text-muted-foreground">
                {mosaicStats.cells.toLocaleString()} tiles ·{" "}
                {mosaicStats.uniquePhotos.toLocaleString()} unique photos
                {mosaicStats.uniqueClips !== null && (
                  <>
                    {" "}
                    · {mosaicStats.uniqueClips.toLocaleString()} unique clips
                  </>
                )}
              </p>
            )}

            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                <span>Resolution</span>
                <span className="tabular-nums">
                  {formatSliderValue(resolutionValue)}
                </span>
              </div>
              <Slider
                className="w-full"
                min={densityMin}
                max={DENSITY_MAX}
                step={2}
                value={[resolutionValue]}
                onValueChange={(v) =>
                  setDensity(densityForResolution(v[0], densityMin))
                }
                aria-label="Mosaic resolution"
              />
            </div>

            {eraEmphasis && (
              <>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                    <span>Recent</span>
                    <span className="tabular-nums">
                      {formatSliderValue(recencyStrength)}
                    </span>
                  </div>
                  <Slider
                    className="w-full"
                    min={0}
                    max={RECENCY_STRENGTH_MAX}
                    step={0.25}
                    value={[recencyStrength]}
                    onValueChange={(v) => setRecencyStrength(v[0])}
                    aria-label="Recent-photo emphasis"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between gap-3 text-sm text-muted-foreground">
                    <span>Playoffs</span>
                    <span className="tabular-nums">
                      {formatSliderValue(playoffBoost)}
                    </span>
                  </div>
                  <Slider
                    className="w-full"
                    min={0}
                    max={PLAYOFF_BOOST_MAX}
                    step={0.25}
                    value={[playoffBoost]}
                    onValueChange={(v) => setPlayoffBoost(v[0])}
                    aria-label="Playoff-photo emphasis"
                  />
                </div>
              </>
            )}
          </SidebarExpandableControls>
        </SidebarFooter>
      </Sidebar>
    </SidebarProvider>
  )
}
