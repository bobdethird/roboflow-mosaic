"use client"

import * as React from "react"

import { MosaicEngine } from "@/lib/mosaic-client"
import { generateBakedMosaic } from "@/lib/mosaic-bake"
import { buildMosaicHitMap } from "@/lib/mosaic-hitmap"
import {
  loadLibrary,
  thumbUrl,
  type LibraryItem,
} from "@/lib/photo-library"
import { loadImage } from "@/lib/mosaic"
import { Button } from "@/components/ui/button"

// Dev-only harness that bakes every photo in public/gallery-original into a
// static mosaic (image + hover hit-map) for the landing-page gallery. Open it in
// a browser (dev server only) and press "Bake all". It reuses the exact engine
// the /knicks-mosaic page runs, so the baked mosaics — and the source frame each
// region resolves to on hover — are identical to a live generate.

const BUCKET = "knicks-mosaic" as const
// Match the /knicks-mosaic resolution presets.
const RESOLUTION_PRESETS = {
  low: { label: "Low", cellSize: 18 },
  medium: { label: "Medium", cellSize: 12 },
  high: { label: "High", cellSize: 8 },
} as const
const RESOLUTION_PRESET_ORDER = ["low", "medium", "high"] as const
const MAX_TILE_REUSE = 20
const WEIGHTING = {
  recencyStrength: 1,
  playoffBoost: 1.5,
  recencyHalfLifeMonths: 18,
  playoffYears: [2025, 2026],
}
// Frame-space granularity of the baked hover grid (px). Coarser than a mosaic
// cell so every bucket reliably contains a tile, but fine enough that hovering
// reveals many different frames as the cursor moves.
const HIT_CELL_PX = 22
// Saved mosaic JPEG long edge + quality (the masonry shows these fairly small).
const SAVE_LONG_EDGE = 1000
const JPEG_QUALITY = 0.82
// Abort a single bake if the worker wedges, so one bad photo can't hang the run.
const BAKE_TIMEOUT_MS = 180_000

type Status = "pending" | "baking" | "done" | "error"
type Row = { file: string; name: string; status: Status; detail?: string }
type ResolutionPreset = (typeof RESOLUTION_PRESET_ORDER)[number]

function baseName(file: string): string {
  return file.replace(/\.[^.]+$/, "")
}

function prettyName(file: string): string {
  return baseName(file).replace(/[-_]+/g, " ").trim()
}

function slugify(file: string): string {
  return (
    baseName(file)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "mosaic"
  )
}

function outputNameForPreset(name: string, preset: ResolutionPreset): string {
  return `${name}-${preset}`
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error("bake timed out")), ms)
    ),
  ])
}

export default function BakePage() {
  const [rows, setRows] = React.useState<Row[]>([])
  const [tileCount, setTileCount] = React.useState<number | null>(null)
  const [running, setRunning] = React.useState(false)
  const [allDone, setAllDone] = React.useState(false)
  const [resolutionPreset, setResolutionPreset] =
    React.useState<ResolutionPreset>("high")

  const engineRef = React.useRef<MosaicEngine | null>(null)
  const idsRef = React.useRef<string[]>([])
  const libraryByIdRef = React.useRef<Map<string, LibraryItem>>(new Map())

  // Spin up the worker + load the knicks library once, then list the sources.
  React.useEffect(() => {
    let cancelled = false
    const engine = new MosaicEngine()
    engineRef.current = engine
    void (async () => {
      const { items } = await loadLibrary(BUCKET)
      if (cancelled) return
      engine.hydrate(items)
      idsRef.current = items.map((it) => it.id)
      libraryByIdRef.current = new Map(items.map((it) => [it.id, it]))
      setTileCount(items.length)

      const res = await fetch("/api/bake/list")
      const { files } = (await res.json()) as { files: string[] }
      if (cancelled) return
      setRows(
        files.map((file) => ({ file, name: slugify(file), status: "pending" }))
      )
    })()
    return () => {
      cancelled = true
      engine.terminate()
      engineRef.current = null
    }
  }, [])

  const setRow = React.useCallback((file: string, patch: Partial<Row>) => {
    setRows((prev) =>
      prev.map((row) => (row.file === file ? { ...row, ...patch } : row))
    )
  }, [])

  const bakeOne = React.useCallback(
    async (
      file: string,
      name: string,
      cellSize: number,
      resolutionLabel: string
    ) => {
      const engine = engineRef.current
      const ids = idsRef.current
      const libraryById = libraryByIdRef.current
      if (!engine || ids.length === 0) throw new Error("library not ready")

      const img = await loadImage(`/gallery-original/${encodeURI(file)}`)
      const { frame, bgColor, base, assignment, centers, tileIds } =
        await withTimeout(
          generateBakedMosaic(engine, img, ids, {
            cellSize,
            maxTileReuse: MAX_TILE_REUSE,
            weighting: WEIGHTING,
          }),
          BAKE_TIMEOUT_MS
        )

      // Paint grout + the worker frame, scaled down to a web-friendly size.
      const scale = Math.min(1, SAVE_LONG_EDGE / Math.max(frame.w, frame.h))
      const sw = Math.max(1, Math.round(frame.w * scale))
      const sh = Math.max(1, Math.round(frame.h * scale))
      const canvas = document.createElement("canvas")
      canvas.width = sw
      canvas.height = sh
      const ctx = canvas.getContext("2d")
      if (!ctx) throw new Error("no 2d context")
      ctx.fillStyle = bgColor
      ctx.fillRect(0, 0, sw, sh)
      ctx.drawImage(base, 0, 0, sw, sh)
      base.close()
      const image = canvas.toDataURL("image/jpeg", JPEG_QUALITY)

      // Build the hover hit grid (shared with the live Publish flow so baked
      // and published maps are identical).
      const cellCount = centers.length / 2
      const { cols, rows: rows_, grid, tiles } = buildMosaicHitMap({
        frameW: frame.w,
        frameH: frame.h,
        centers,
        assignment,
        tileIds,
        hitCellPx: HIT_CELL_PX,
        resolveTile: (id) => {
          const item = libraryById.get(id)
          return {
            url: item?.fullUrl ?? item?.url ?? thumbUrl(BUCKET, id),
            previewUrl: item?.url ?? thumbUrl(BUCKET, id),
            title: item?.galleryTitle ?? item?.gallery ?? id,
          }
        },
      })

      const res = await fetch("/api/bake/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          alt: `${prettyName(file)} rebuilt as a ${resolutionLabel.toLowerCase()} resolution mosaic of Knicks footage frames`,
          image,
          w: sw,
          h: sh,
          cols,
          rows: rows_,
          grid,
          tiles,
        }),
      })
      if (!res.ok) throw new Error(`save failed (${res.status})`)
      return { tiles: tiles.length, cells: cellCount }
    },
    []
  )

  const bakeAll = React.useCallback(async () => {
    if (running) return
    setRunning(true)
    setAllDone(false)
    // Stable, collision-free names within this run (e.g. trophy.jpeg vs
    // trophy.webp would otherwise both slugify to "trophy").
    const used = new Set<string>()
    const preset = resolutionPreset
    const resolution = RESOLUTION_PRESETS[preset]
    const current = rows.map((row) => {
      let name = row.name
      let n = 2
      while (used.has(outputNameForPreset(name, preset))) {
        name = `${row.name}-${n++}`
      }
      used.add(outputNameForPreset(name, preset))
      return { ...row, name }
    })
    setRows(current.map((row) => ({ ...row, status: "pending" as Status })))

    for (const row of current) {
      setRow(row.file, { status: "baking", detail: undefined })
      try {
        const { tiles, cells } = await bakeOne(
          row.file,
          outputNameForPreset(row.name, preset),
          resolution.cellSize,
          resolution.label
        )
        setRow(row.file, {
          status: "done",
          detail: `${resolution.label}: ${cells.toLocaleString()} cells · ${tiles} frames`,
        })
      } catch (err) {
        setRow(row.file, {
          status: "error",
          detail: err instanceof Error ? err.message : String(err),
        })
      }
    }
    setRunning(false)
    setAllDone(true)
  }, [rows, running, bakeOne, setRow, resolutionPreset])

  const doneCount = rows.filter((r) => r.status === "done").length
  const errorCount = rows.filter((r) => r.status === "error").length
  const activeResolution = RESOLUTION_PRESETS[resolutionPreset]

  return (
    <main className="mx-auto flex min-h-svh max-w-2xl flex-col gap-6 p-8 font-sans">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Mosaic baker</h1>
        <p className="text-sm text-muted-foreground">
          Dev-only. Bakes <code>public/gallery-original/*</code> into static
          mosaics + hover maps under <code>public/gallery</code>.
        </p>
        <p className="text-sm text-muted-foreground">
          Library:{" "}
          {tileCount === null
            ? "loading…"
            : `${tileCount.toLocaleString()} tiles`}{" "}
          · {rows.length} sources · {doneCount} done
          {errorCount > 0 ? ` · ${errorCount} error` : ""}
        </p>
      </header>

      <section className="flex flex-col gap-3 rounded-lg border p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <h2 className="text-sm font-medium">Resolution</h2>
            <p className="text-xs text-muted-foreground">
              Smaller cells create more detail and take longer to bake. Current:{" "}
              {activeResolution.cellSize}px cells. Outputs use a{" "}
              <code>-{resolutionPreset}</code> suffix.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {RESOLUTION_PRESET_ORDER.map((preset) => {
              const option = RESOLUTION_PRESETS[preset]
              const selected = preset === resolutionPreset
              return (
                <Button
                  key={preset}
                  type="button"
                  variant={selected ? "default" : "outline"}
                  size="sm"
                  aria-pressed={selected}
                  disabled={running}
                  onClick={() => setResolutionPreset(preset)}
                >
                  {option.label}
                  <span className="text-xs opacity-70">
                    {option.cellSize}px
                  </span>
                </Button>
              )
            })}
          </div>
        </div>
        <Button
          onClick={bakeAll}
          disabled={running || tileCount === null || rows.length === 0}
        >
          {running
            ? `Baking ${activeResolution.label.toLowerCase()}…`
            : `Bake all (${activeResolution.label.toLowerCase()})`}
        </Button>
      </section>

      <ol className="flex flex-col gap-1.5 text-sm">
        {rows.map((row) => (
          <li
            key={row.file}
            className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
          >
            <span className="flex items-center gap-2">
              <span
                aria-hidden
                className={
                  row.status === "done"
                    ? "size-2 rounded-full bg-green-500"
                    : row.status === "baking"
                      ? "size-2 animate-pulse rounded-full bg-amber-500"
                      : row.status === "error"
                        ? "size-2 rounded-full bg-red-500"
                        : "size-2 rounded-full bg-muted-foreground/40"
                }
              />
              <span className="font-medium">{row.file}</span>
              <span className="text-muted-foreground">
                → {outputNameForPreset(row.name, resolutionPreset)}.jpg
              </span>
            </span>
            <span className="text-right text-xs text-muted-foreground">
              {row.detail ?? row.status}
            </span>
          </li>
        ))}
      </ol>

      {/* Stable marker so automated runs can detect completion. */}
      <div
        data-bake-state={running ? "running" : allDone ? "done" : "idle"}
        data-bake-done={String(doneCount)}
        data-bake-total={String(rows.length)}
        className="sr-only"
      >
        {running ? "running" : allDone ? "done" : "idle"}
      </div>
    </main>
  )
}
