// Offline mosaic "baking": reproduces the exact generation pipeline that
// canvas-hero.tsx runs interactively (handleGenerate), but as a reusable helper
// the dev-only /bake page drives once per gallery photo. The result (the baked
// frame plus the per-cell tile assignment + centers) is what lets the static
// masonry gallery resolve the source frame under the cursor — the same hover
// popup as /knicks-mosaic — without shipping the live engine to the landing page.
//
// This module only runs client-side (it spins up the mosaic Web Worker via
// MosaicEngine), so it must be imported from a "use client" entry point.

import { MosaicEngine } from "./mosaic-client"
import {
  averageColor,
  edgeVectorField,
  gridForCellSize,
  referenceWindowSignatures,
} from "./mosaic"
import { contourMosaic } from "./contour-mosaic"
import type { TileWeighting } from "./mosaic-protocol"

// Mirrors canvas-hero.tsx: the flat mosaic frame's long edge, and the (coarse)
// edge-vector field resolution that steers tile orientation. Kept in sync by
// hand so this helper stays decoupled from the component.
const CANVAS_LONG_EDGE = 1600
const FIELD_LONG_EDGE = 360

const evenDim = (n: number) => Math.max(2, Math.round(n / 2) * 2)

// Flat mosaic frame sized to the reference's aspect, long edge = CANVAS_LONG_EDGE.
export function frameDimsFor(w: number, h: number): { w: number; h: number } {
  const aspect = w / h
  return aspect >= 1
    ? { w: CANVAS_LONG_EDGE, h: evenDim(CANVAS_LONG_EDGE / aspect) }
    : { w: evenDim(CANVAS_LONG_EDGE * aspect), h: CANVAS_LONG_EDGE }
}

// Edge-vector field dims, matching the frame's aspect at a coarse resolution.
function fieldDimsFor(w: number, h: number): { fw: number; fh: number } {
  const aspect = w / h
  return aspect >= 1
    ? { fw: FIELD_LONG_EDGE, fh: Math.max(1, Math.round(FIELD_LONG_EDGE / aspect)) }
    : { fw: Math.max(1, Math.round(FIELD_LONG_EDGE * aspect)), fh: FIELD_LONG_EDGE }
}

export type BakedMosaic = {
  // Mosaic frame dimensions the assignment/centers live in.
  frame: { w: number; h: number }
  // Reference's average color — the grout painted behind the tiles.
  bgColor: string
  // The finished, transparent-background mosaic frame from the worker. The
  // caller draws it over `bgColor` and owns closing it.
  base: ImageBitmap
  // Per-cell matched tile (index into `tileIds`), index-aligned with `centers`.
  assignment: Int32Array
  // Per-cell center (x,y pairs) in frame coordinates.
  centers: Float32Array
  // Library photo ids, indexed by `assignment`.
  tileIds: string[]
}

export type BakeOptions = {
  // Mosaic cell size in px (smaller = finer/higher-resolution mosaic).
  cellSize: number
  // Per-render cap on how many cells a single source photo may fill.
  maxTileReuse?: number
  // Optional recency/playoff era bias (knicks collection).
  weighting?: TileWeighting
}

// Run the full contour-flow generation for one reference image against an
// already-hydrated engine + library id list, returning the finished frame and
// the geometry needed to build a hover hit-map. Mirrors handleGenerate exactly.
export async function generateBakedMosaic(
  engine: MosaicEngine,
  refImg: HTMLImageElement,
  ids: string[],
  options: BakeOptions
): Promise<BakedMosaic> {
  const { w: canvasW, h: canvasH } = frameDimsFor(
    refImg.naturalWidth,
    refImg.naturalHeight
  )
  const bgColor = averageColor(refImg)
  const grid = gridForCellSize(options.cellSize, canvasW, canvasH)
  const { fw, fh } = fieldDimsFor(canvasW, canvasH)
  const vfield = edgeVectorField(refImg, fw, fh)
  const cm = contourMosaic(canvasW, canvasH, options.cellSize, vfield)
  const cellSigs = referenceWindowSignatures(
    refImg,
    cm.centers,
    cm.tileSize,
    canvasW,
    canvasH
  )
  const { assignment, base } = await engine.generate(
    cellSigs,
    grid,
    ids,
    cm.angles,
    cm.polys,
    cm.offsets,
    canvasW,
    canvasH,
    undefined,
    undefined,
    { maxTileReuse: options.maxTileReuse, weighting: options.weighting }
  )
  return {
    frame: { w: canvasW, h: canvasH },
    bgColor,
    base,
    assignment,
    centers: cm.centers,
    tileIds: [...ids],
  }
}
