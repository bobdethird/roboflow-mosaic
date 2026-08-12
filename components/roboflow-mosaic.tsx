"use client"

// Paste a Roboflow Universe dataset URL; get a photo mosaic of that dataset.
//
// Two halves:
//   1. Ingest — POST the URL to /api/roboflow/ingest and poll until the server
//      has built the tile library and the dataset's median image.
//   2. Generate — hydrate the mosaic Web Worker with those tiles and run the
//      same contour-flow generation the rest of the site uses. Either way the
//      mosaic is the dataset drawing itself, out of its own images; the switch
//      is what it draws — the project's cover image (default), or the median,
//      the shape every image in the set agrees on.

import * as React from "react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { contourMosaic } from "@/lib/contour-mosaic"
import { MosaicEngine } from "@/lib/mosaic-client"
import {
  averageColor,
  edgeVectorField,
  gridForCellSize,
  loadImage,
  referenceWindowSignatures,
} from "@/lib/mosaic"
import { frameDimsFor } from "@/lib/mosaic-bake"
import {
  ROBOFLOW_COVER_PATH,
  ROBOFLOW_INGEST_PATH,
  parseRoboflowUrl,
  type IngestStatus,
  type ReferenceKind,
  type RoboflowDataset,
} from "@/lib/roboflow"
import {
  loadRoboflowLibrary,
  roboflowReferenceUrl,
} from "@/lib/roboflow-library"

// Matches lib/mosaic-bake.ts: the coarse edge-vector field that steers tile
// orientation is computed at this long edge.
const FIELD_LONG_EDGE = 360
// A single dataset image should not be allowed to carpet the mosaic.
const MAX_TILE_REUSE = 24
// Cell size in mosaic-frame pixels. Smaller = more tiles = finer mosaic.
const CELL_SIZES = [28, 22, 18, 14, 11, 9]
const DEFAULT_DENSITY = 2

const EXAMPLE_URL = "https://universe.roboflow.com/joseph-nelson/chess-pieces-new"

const REFERENCE_LABELS: Record<ReferenceKind, string> = {
  icon: "Project cover",
  median: "Median image",
}

const REFERENCE_BLURBS: Record<ReferenceKind, string> = {
  icon: "The cover image the dataset's author chose",
  median: "Per-pixel median of the whole dataset",
}

type Phase = "idle" | "ingesting" | "loading" | "generating" | "done" | "error"

function fieldDimsFor(w: number, h: number): { fw: number; fh: number } {
  const aspect = w / h
  return aspect >= 1
    ? { fw: FIELD_LONG_EDGE, fh: Math.max(1, Math.round(FIELD_LONG_EDGE / aspect)) }
    : { fw: Math.max(1, Math.round(FIELD_LONG_EDGE * aspect)), fh: FIELD_LONG_EDGE }
}

async function startIngest(url: string): Promise<IngestStatus> {
  const response = await fetch(ROBOFLOW_INGEST_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  })
  const body = (await response.json()) as IngestStatus & { error?: string }
  if (!response.ok) throw new Error(body.error ?? "Could not start the ingest.")
  return body
}

async function pollIngest(
  slug: string,
  onStatus: (status: IngestStatus) => void,
  signal: AbortSignal
): Promise<RoboflowDataset> {
  for (;;) {
    if (signal.aborted) throw new Error("Cancelled")
    const response = await fetch(
      `${ROBOFLOW_INGEST_PATH}?slug=${encodeURIComponent(slug)}`,
      { signal }
    )
    const status = (await response.json()) as IngestStatus & { error?: string }
    if (!response.ok) throw new Error(status.error ?? "Lost track of the ingest.")
    onStatus(status)
    if (status.state === "error") throw new Error(status.error ?? "Ingest failed.")
    if (status.state === "ready") {
      if (!status.dataset) throw new Error("The ingest finished without a dataset record.")
      return status.dataset
    }
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
}

// Ask the server to pull the project's cover image into an already-ingested
// dataset. Cheap next to a re-ingest, so the reference switch can offer it even
// when the original ingest predates cover images.
async function fetchCover(slug: string): Promise<void> {
  const response = await fetch(ROBOFLOW_COVER_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug }),
  })
  const body = (await response.json()) as { hasIcon?: boolean; error?: string }
  if (!response.ok || !body.hasIcon) {
    throw new Error(body.error ?? "Could not fetch the cover image.")
  }
}

export function RoboflowMosaic() {
  const [url, setUrl] = React.useState("")
  const [phase, setPhase] = React.useState<Phase>("idle")
  const [status, setStatus] = React.useState<IngestStatus | null>(null)
  const [dataset, setDataset] = React.useState<RoboflowDataset | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [density, setDensity] = React.useState(DEFAULT_DENSITY)
  const [tileCount, setTileCount] = React.useState(0)
  const [progress, setProgress] = React.useState({ done: 0, total: 0 })
  const [referenceUrl, setReferenceUrl] = React.useState<string | null>(null)
  // Which image the mosaic reproduces. The project's cover image is the default
  // when the ingest managed to fetch one; the median is always available.
  const [referenceKind, setReferenceKind] =
    React.useState<ReferenceKind>("icon")
  // Overrides the generic "loading" status line for one-off waits.
  const [loadingNote, setLoadingNote] = React.useState<string | null>(null)

  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const engineRef = React.useRef<MosaicEngine | null>(null)
  const abortRef = React.useRef<AbortController | null>(null)
  // Ids of the hydrated library, in the order the worker indexes them.
  const idsRef = React.useRef<string[]>([])
  const referenceRef = React.useRef<HTMLImageElement | null>(null)

  React.useEffect(() => {
    return () => {
      engineRef.current?.terminate()
      abortRef.current?.abort()
    }
  }, [])

  const draw = React.useCallback(
    (base: ImageBitmap, bgColor: string, width: number, height: number) => {
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext("2d")
      if (!ctx) return
      ctx.fillStyle = bgColor
      ctx.fillRect(0, 0, width, height)
      ctx.drawImage(base, 0, 0)
    },
    []
  )

  // Run the contour-flow generation against the already-hydrated engine. Split
  // out from `handleGenerate` so the density control can re-render without
  // re-ingesting or re-hydrating.
  const runGeneration = React.useCallback(
    async (cellSize: number) => {
      const engine = engineRef.current
      const reference = referenceRef.current
      if (!engine || !reference) return

      setPhase("generating")
      setProgress({ done: 0, total: 0 })

      const { w, h } = frameDimsFor(
        reference.naturalWidth,
        reference.naturalHeight
      )
      const bgColor = averageColor(reference)
      const grid = gridForCellSize(cellSize, w, h)
      const { fw, fh } = fieldDimsFor(w, h)
      const vfield = edgeVectorField(reference, fw, fh)
      const cm = contourMosaic(w, h, cellSize, vfield)
      const cellSigs = referenceWindowSignatures(
        reference,
        cm.centers,
        cm.tileSize,
        w,
        h
      )

      const { base } = await engine.generate(
        cellSigs,
        grid,
        idsRef.current,
        cm.angles,
        cm.polys,
        cm.offsets,
        w,
        h,
        (frame, done, total) => {
          draw(frame, bgColor, w, h)
          frame.close()
          setProgress({ done, total })
        },
        (done, total) => setProgress({ done, total }),
        { maxTileReuse: MAX_TILE_REUSE }
      )
      draw(base, bgColor, w, h)
      base.close()
      setTileCount(cm.centers.length / 2)
      setPhase("done")
    },
    [draw]
  )

  const handleGenerate = React.useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setError(null)
    setDataset(null)
    setStatus(null)
    setReferenceUrl(null)

    try {
      parseRoboflowUrl(url)
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : "Bad URL.")
      setPhase("error")
      return
    }

    try {
      setPhase("ingesting")
      const started = await startIngest(url)
      setStatus(started)
      const resolved =
        started.state === "ready" && started.dataset
          ? started.dataset
          : await pollIngest(started.slug, setStatus, controller.signal)
      setDataset(resolved)

      setPhase("loading")
      const { items } = await loadRoboflowLibrary(resolved.slug)
      engineRef.current?.terminate()
      const engine = new MosaicEngine()
      engine.hydrate(
        items.map(({ id, sig, w, h, url: thumb }) => ({ id, sig, w, h, url: thumb }))
      )
      engineRef.current = engine
      idsRef.current = items.map((item) => item.id)

      // Prefer the project's own cover image; fall back to the median when the
      // project has none (or the ingest could not fetch it).
      const kind: ReferenceKind = resolved.hasIcon ? "icon" : "median"
      setReferenceKind(kind)
      const refUrl = roboflowReferenceUrl(resolved.slug, kind)
      setReferenceUrl(refUrl)
      referenceRef.current = await loadImage(refUrl)

      await runGeneration(CELL_SIZES[density])
    } catch (runError) {
      if (controller.signal.aborted) return
      setError(runError instanceof Error ? runError.message : "Something went wrong.")
      setPhase("error")
    }
  }, [density, runGeneration, url])

  // Swap the reference and re-render. Both images were written by the ingest, so
  // this is a client-side re-run — no refetch of the dataset.
  const handleReferenceKind = React.useCallback(
    (kind: ReferenceKind) => {
      if (!dataset || kind === referenceKind) return
      setError(null)
      void (async () => {
        try {
          // A dataset ingested before cover images were saved has everything
          // else on disk; pull just the cover rather than re-ingesting.
          if (kind === "icon" && !dataset.hasIcon) {
            setPhase("loading")
            setLoadingNote("Fetching the project cover image")
            await fetchCover(dataset.slug)
            setDataset({ ...dataset, hasIcon: true })
            setLoadingNote(null)
          }
          const refUrl = roboflowReferenceUrl(dataset.slug, kind)
          setReferenceKind(kind)
          setReferenceUrl(refUrl)
          referenceRef.current = await loadImage(refUrl)
          await runGeneration(CELL_SIZES[density])
        } catch (runError) {
          setLoadingNote(null)
          setError(
            runError instanceof Error ? runError.message : "Re-render failed."
          )
          setPhase("error")
        }
      })()
    },
    [dataset, density, referenceKind, runGeneration]
  )

  const handleDensityCommit = React.useCallback(
    (value: number[]) => {
      const next = value[0]
      setDensity(next)
      if (referenceRef.current && engineRef.current) {
        void runGeneration(CELL_SIZES[next]).catch((runError: unknown) => {
          setError(runError instanceof Error ? runError.message : "Re-render failed.")
          setPhase("error")
        })
      }
    },
    [runGeneration]
  )

  const handleDownload = React.useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas || !dataset) return
    const link = document.createElement("a")
    link.download = `${dataset.slug}-mosaic.png`
    link.href = canvas.toDataURL("image/png")
    link.click()
  }, [dataset])

  const busy =
    phase === "ingesting" || phase === "loading" || phase === "generating"

  const statusLine = (() => {
    if (phase === "ingesting" && status) {
      const pct =
        status.total > 0
          ? ` — ${Math.round((status.done / status.total) * 100)}%`
          : ""
      return `${status.step}${pct}`
    }
    if (phase === "loading") return loadingNote ?? "Loading tile signatures"
    if (phase === "generating") {
      return progress.total > 0
        ? `Placing tiles — ${progress.done}/${progress.total}`
        : "Laying out cells"
    }
    return null
  })()

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 py-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">
          Roboflow dataset mosaic
        </h1>
        <p className="text-muted-foreground max-w-2xl text-sm">
          Paste a Roboflow Universe dataset URL. Every image in the dataset
          becomes a tile, so the result is the dataset rendered out of itself.
          What it reproduces is the project&rsquo;s{" "}
          <strong>cover image</strong> — or switch to the dataset&rsquo;s{" "}
          <strong>median image</strong>, the per-pixel median of the whole set.
        </p>
      </header>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !busy) void handleGenerate()
          }}
          placeholder={EXAMPLE_URL}
          spellCheck={false}
          className="flex-1"
          aria-label="Roboflow Universe dataset URL"
        />
        <Button onClick={() => void handleGenerate()} disabled={busy || !url.trim()}>
          {busy ? "Working…" : "Generate"}
        </Button>
      </div>

      {!url && (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground self-start text-xs underline underline-offset-4"
          onClick={() => setUrl(EXAMPLE_URL)}
        >
          Try {EXAMPLE_URL}
        </button>
      )}

      {error && (
        <p className="border-destructive/40 bg-destructive/5 text-destructive rounded-xl border px-4 py-3 text-sm">
          {error}
        </p>
      )}

      {statusLine && (
        <p className="text-muted-foreground text-sm tabular-nums">{statusLine}</p>
      )}

      {dataset && (
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <a
            href={dataset.universeUrl}
            target="_blank"
            rel="noreferrer"
            className="text-foreground font-medium underline underline-offset-4"
          >
            {dataset.name}
          </a>
          <span>v{dataset.version}</span>
          <span>{dataset.imageCount.toLocaleString()} tiles</span>
          {tileCount > 0 && <span>{tileCount.toLocaleString()} cells</span>}
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-[1fr_180px]">
        <div className="bg-muted/30 overflow-hidden rounded-2xl border">
          <canvas ref={canvasRef} className="h-auto w-full" />
        </div>
        <aside className="flex flex-col gap-4">
          {referenceUrl && (
            <figure className="flex flex-col gap-2">
              {/* Both references are generated per dataset, so next/image's
                  optimizer has nothing to pre-size — a plain img is correct. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={referenceUrl}
                alt={`${REFERENCE_LABELS[referenceKind]} — the mosaic's reference`}
                className="w-full rounded-xl border"
              />
              <figcaption className="text-muted-foreground text-xs">
                {REFERENCE_BLURBS[referenceKind]}
              </figcaption>
              <div className="flex gap-1">
                {(["icon", "median"] as const).map((kind) => (
                  <Button
                    key={kind}
                    size="xs"
                    variant={kind === referenceKind ? "default" : "outline"}
                    onClick={() => handleReferenceKind(kind)}
                    disabled={busy}
                    title={
                      kind === "icon" && !dataset?.hasIcon
                        ? "Downloads the project's cover image from Roboflow"
                        : undefined
                    }
                  >
                    {REFERENCE_LABELS[kind]}
                  </Button>
                ))}
              </div>
            </figure>
          )}
          {(phase === "done" || phase === "generating") && (
            <div className="flex flex-col gap-2">
              <label className="text-muted-foreground text-xs" htmlFor="density">
                Density
              </label>
              <Slider
                id="density"
                min={0}
                max={CELL_SIZES.length - 1}
                step={1}
                value={[density]}
                onValueChange={(value) => setDensity(value[0])}
                onValueCommit={handleDensityCommit}
                disabled={phase === "generating"}
              />
              <Button
                variant="outline"
                onClick={handleDownload}
                disabled={phase !== "done"}
              >
                Download PNG
              </Button>
            </div>
          )}
        </aside>
      </div>
    </main>
  )
}
