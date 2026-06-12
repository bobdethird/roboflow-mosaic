import { CONFIG } from "../config.mjs"
import { clamp } from "./common.mjs"

// The mosaic layout: the centered rect the contour tiles span on the output
// canvas (matching the reference's aspect — the leftover canvas letterboxes to
// the grout color) plus the tile size the geometry was laid at.
export function mosaicLayoutForReference(refWidth, refHeight) {
  const { outputWidth, outputHeight } = CONFIG.mosaic
  if (!refWidth || !refHeight) {
    return { x: 0, y: 0, w: outputWidth, h: outputHeight }
  }
  const scale = Math.min(outputWidth / refWidth, outputHeight / refHeight)
  const w = refWidth * scale
  const h = refHeight * scale
  return {
    x: (outputWidth - w) / 2,
    y: (outputHeight - h) / 2,
    w,
    h,
  }
}

// Layout stored in a match plan (rect + tile size).
export function planMosaicLayout(plan) {
  const grid = plan?.grid
  if (!grid?.mosaicRect) {
    throw new Error("Match plan has no mosaicRect. Re-run pnpm knicks:match.")
  }
  return { ...grid.mosaicRect, tileSize: grid.tileSize ?? 40 }
}

// The visible world-space window at `time` during the pre-roll: starts roughly
// one tile wide around the focus point and eases out to the full canvas.
export function zoomWindow(time, layout) {
  const {
    outputWidth,
    outputHeight,
    openingCols,
    openingRows,
    focusX,
    focusY,
    preRollSec,
  } = CONFIG.mosaic
  const progress = clamp(time / preRollSec, 0, 1)
  const aspect = outputWidth / outputHeight
  const tile = layout.tileSize ?? 40
  const desiredW = tile * Math.max(1, openingCols)
  const desiredH = tile * Math.max(1, openingRows)
  const startW = Math.min(outputWidth, Math.max(desiredW, desiredH * aspect))
  const startH = startW / aspect
  const w = startW + (outputWidth - startW) * progress
  const h = startH + (outputHeight - startH) * progress
  return {
    x: clamp(layout.x + layout.w * focusX - w / 2, 0, outputWidth - w),
    y: clamp(layout.y + layout.h * focusY - h / 2, 0, outputHeight - h),
    w,
    h,
  }
}

// World-space bounds of one cell's polygon (precomputed in the plan geometry).
export function cellBoundsRect(geometry, cellIndex) {
  return {
    x: geometry.bboxes[cellIndex * 4],
    y: geometry.bboxes[cellIndex * 4 + 1],
    w: geometry.bboxes[cellIndex * 4 + 2],
    h: geometry.bboxes[cellIndex * 4 + 3],
  }
}

export function intersects(a, b) {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  )
}

// Largest on-screen size any of a candidate's cells reaches during the
// pre-roll zoom (sampled per output frame), used to size the extracted clip.
export function maxScreenSizeForCandidate(plan, geometry, candidateKey) {
  const { preRollSec, fps, outputWidth, outputHeight } = CONFIG.mosaic
  const layout = planMosaicLayout(plan)
  const cells = plan.assignments
    .filter((assignment) => assignment.candidateKey === candidateKey)
    .map((assignment) => assignment.cellIndex)
  let maxW = 0
  let maxH = 0
  const samples = Math.max(1, Math.round(preRollSec * fps))

  for (let i = 0; i <= samples; i++) {
    const time = (preRollSec * i) / samples
    const window = zoomWindow(time, layout)
    const scale = outputWidth / window.w
    for (const cellIndex of cells) {
      const cell = cellBoundsRect(geometry, cellIndex)
      if (!intersects(cell, window)) continue
      maxW = Math.max(maxW, cell.w * scale)
      maxH = Math.max(maxH, cell.h * scale)
    }
  }

  if (!maxW || !maxH) {
    const fallback = cells.length ? cellBoundsRect(geometry, cells[0]) : null
    maxW = fallback?.w || CONFIG.mosaic.outputWidth
    maxH = fallback?.h || CONFIG.mosaic.outputHeight
  }

  return {
    width: Math.min(outputWidth, Math.ceil(maxW * 1.15)),
    height: Math.min(outputHeight, Math.ceil(maxH * 1.15)),
  }
}
