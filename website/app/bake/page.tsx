"use client"

import * as React from "react"

import { MosaicEngine } from "@/lib/mosaic-client"
import { generateBakedMosaic } from "@/lib/mosaic-bake"
import {
  loadLibrary,
  thumbUrl,
  type LibraryItem,
} from "@/lib/photo-library"
import { loadImage } from "@/lib/mosaic"
import type { GalleryTile } from "@/lib/gallery"
import { Button } from "@/components/ui/button"

// Dev-only harness that bakes every photo in public/gallery-original into a
// static mosaic (image + hover hit-map) for the landing-page gallery. Open it in
// a browser (dev server only) and press "Bake all". It reuses the exact engine
// the /knicks-mosaic page runs, so the baked mosaics — and the source frame each
// region resolves to on hover — are identical to a live generate.

const BUCKET = "knicks-mosaic" as const
// Match the /knicks-mosaic "high" resolution preset (8px cells) for maximum detail.
const CELL_SIZE = 8
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
    async (file: string, name: string) => {
      const engine = engineRef.current
      const ids = idsRef.current
      const libraryById = libraryByIdRef.current
      if (!engine || ids.length === 0) throw new Error("library not ready")

      const img = await loadImage(`/gallery-original/${encodeURI(file)}`)
      const { frame, bgColor, base, assignment, centers, tileIds } =
        await withTimeout(
          generateBakedMosaic(engine, img, ids, {
            cellSize: CELL_SIZE,
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

      // Build the hover hit grid: per bucket, keep the cell whose center is
      // nearest the bucket center, then compact to only the referenced frames.
      const cols = Math.max(1, Math.round(frame.w / HIT_CELL_PX))
      const rows_ = Math.max(1, Math.round(frame.h / HIT_CELL_PX))
      const cellW = frame.w / cols
      const cellH = frame.h / rows_
      const bestDist = new Float64Array(cols * rows_).fill(Infinity)
      const bucketTile = new Int32Array(cols * rows_).fill(-1)
      const cellCount = centers.length / 2
      for (let i = 0; i < cellCount; i++) {
        const cx = centers[i * 2]
        const cy = centers[i * 2 + 1]
        let gx = Math.floor(cx / cellW)
        let gy = Math.floor(cy / cellH)
        if (gx < 0) gx = 0
        else if (gx >= cols) gx = cols - 1
        if (gy < 0) gy = 0
        else if (gy >= rows_) gy = rows_ - 1
        const b = gy * cols + gx
        const dx = cx - (gx + 0.5) * cellW
        const dy = cy - (gy + 0.5) * cellH
        const d = dx * dx + dy * dy
        if (d < bestDist[b]) {
          bestDist[b] = d
          bucketTile[b] = assignment[i]
        }
      }

      const compact = new Map<number, number>()
      const tiles: GalleryTile[] = []
      const grid = new Array<number>(cols * rows_)
      for (let b = 0; b < grid.length; b++) {
        const li = bucketTile[b]
        if (li < 0) {
          grid[b] = -1
          continue
        }
        let ci = compact.get(li)
        if (ci === undefined) {
          const id = tileIds[li]
          const item = libraryById.get(id)
          tiles.push({
            url: item?.fullUrl ?? item?.url ?? thumbUrl(BUCKET, id),
            title: item?.galleryTitle ?? item?.gallery ?? id,
          })
          ci = tiles.length - 1
          compact.set(li, ci)
        }
        grid[b] = ci
      }

      const res = await fetch("/api/bake/save", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          alt: `${prettyName(file)} rebuilt as a mosaic of Knicks footage frames`,
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
    const current = rows.map((row) => {
      let name = row.name
      let n = 2
      while (used.has(name)) name = `${row.name}-${n++}`
      used.add(name)
      return { ...row, name }
    })
    setRows(current.map((row) => ({ ...row, status: "pending" as Status })))

    for (const row of current) {
      setRow(row.file, { status: "baking", detail: undefined })
      try {
        const { tiles, cells } = await bakeOne(row.file, row.name)
        setRow(row.file, {
          status: "done",
          detail: `${cells.toLocaleString()} cells · ${tiles} frames`,
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
  }, [rows, running, bakeOne, setRow])

  const doneCount = rows.filter((r) => r.status === "done").length
  const errorCount = rows.filter((r) => r.status === "error").length

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

      <div>
        <Button
          onClick={bakeAll}
          disabled={running || tileCount === null || rows.length === 0}
        >
          {running ? "Baking…" : "Bake all"}
        </Button>
      </div>

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
              <span className="text-muted-foreground">→ {row.name}.jpg</span>
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
