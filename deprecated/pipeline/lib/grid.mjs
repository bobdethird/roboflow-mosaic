import { CONFIG } from "../config.mjs"
import { clamp } from "./common.mjs"

export function buildGridGeometry({
  cols = CONFIG.mosaic.gridCols,
  rows = CONFIG.mosaic.gridRows,
  width = CONFIG.mosaic.outputWidth,
  height = CONFIG.mosaic.outputHeight,
} = {}) {
  const cellWidth = width / cols
  const cellHeight = height / rows
  const centers = new Float32Array(cols * rows * 2)
  const bboxes = new Float32Array(cols * rows * 4)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cell = row * cols + col
      const x = col * cellWidth
      const y = row * cellHeight
      centers[cell * 2] = x + cellWidth / 2
      centers[cell * 2 + 1] = y + cellHeight / 2
      bboxes[cell * 4] = x
      bboxes[cell * 4 + 1] = y
      bboxes[cell * 4 + 2] = cellWidth
      bboxes[cell * 4 + 3] = cellHeight
    }
  }
  return { cols, rows, width, height, cellWidth, cellHeight, centers, bboxes }
}

// Nearest cell center to the configured focus point (works for both layouts).
export function openingCellForCenters(centers, width, height) {
  const fx = width * clamp(CONFIG.mosaic.focusX, 0, 1)
  const fy = height * clamp(CONFIG.mosaic.focusY, 0, 1)
  let bestCell = 0
  let bestDist = Infinity
  for (let i = 0; i < centers.length / 2; i++) {
    const dx = centers[i * 2] - fx
    const dy = centers[i * 2 + 1] - fy
    const d = dx * dx + dy * dy
    if (d < bestDist) {
      bestDist = d
      bestCell = i
    }
  }
  return bestCell
}

export function openingCellForGrid(geometry) {
  return openingCellForCenters(geometry.centers, geometry.width, geometry.height)
}

// Cell indices of a centered cols×rows block within a `cols`×`rows` grid.
// Used to restrict matching to the middle of the frame so the rest can show
// the reference photo. Returned ascending (row-major) for deterministic plans.
export function centerBlockCells(cols, rows, centerCols, centerRows) {
  const cc = Math.max(1, Math.min(cols, Math.floor(centerCols)))
  const cr = Math.max(1, Math.min(rows, Math.floor(centerRows)))
  const c0 = Math.floor((cols - cc) / 2)
  const r0 = Math.floor((rows - cr) / 2)
  const cells = []
  for (let r = r0; r < r0 + cr; r++) {
    for (let c = c0; c < c0 + cc; c++) {
      cells.push(r * cols + c)
    }
  }
  return cells
}

// Nearest cell center to the focus point, restricted to a subset of cells.
export function openingCellForCells(centers, cells, width, height) {
  const fx = width * clamp(CONFIG.mosaic.focusX, 0, 1)
  const fy = height * clamp(CONFIG.mosaic.focusY, 0, 1)
  let bestCell = cells.length ? cells[0] : 0
  let bestDist = Infinity
  for (const cell of cells) {
    const dx = centers[cell * 2] - fx
    const dy = centers[cell * 2 + 1] - fy
    const d = dx * dx + dy * dy
    if (d < bestDist) {
      bestDist = d
      bestCell = cell
    }
  }
  return bestCell
}

// World-space bounds of one assignment's cell. For voronoi plans `geometry`
// (decoded from plan.geometry) provides per-cell polygon bboxes; grid plans
// derive the rect from row/col.
export function cellRectFromPlan(assignment, plan, geometry = null) {
  if (geometry) {
    const i = assignment.cellIndex
    return {
      x: geometry.bboxes[i * 4],
      y: geometry.bboxes[i * 4 + 1],
      w: geometry.bboxes[i * 4 + 2],
      h: geometry.bboxes[i * 4 + 3],
    }
  }
  return {
    x: assignment.col * plan.grid.cellWidth,
    y: assignment.row * plan.grid.cellHeight,
    w: plan.grid.cellWidth,
    h: plan.grid.cellHeight,
  }
}

// Start window of the zoom: the opening cell expanded to the output aspect so
// the window never distorts (voronoi cells have arbitrary aspect).
export function zoomStartWindow(plan, geometry = null) {
  const { outputWidth, outputHeight } = plan.grid
  // assignments may be a sparse subset (center-only grid), so resolve the
  // opening cell by its cellIndex rather than by array position.
  const opening =
    plan.assignments.find((a) => a.cellIndex === plan.grid.openingCell) ??
    plan.assignments[0]
  const rect = cellRectFromPlan(opening, plan, geometry)
  const aspect = outputWidth / outputHeight
  const w = Math.min(outputWidth, Math.max(rect.w, rect.h * aspect))
  const h = w / aspect
  return {
    x: clamp(rect.x + rect.w / 2 - w / 2, 0, outputWidth - w),
    y: clamp(rect.y + rect.h / 2 - h / 2, 0, outputHeight - h),
    w,
    h,
  }
}

export function zoomWindow(time, plan, geometry = null) {
  const { outputWidth, outputHeight } = plan.grid
  const { preRollSec } = plan.timing
  const configuredZoomDuration = CONFIG.mosaic.zoomDurationSec || 0
  const zoomDurationSec =
    configuredZoomDuration > 0
      ? Math.min(configuredZoomDuration, preRollSec)
      : preRollSec
  const zoomHoldSec = Math.min(
    Math.max(0, CONFIG.mosaic.zoomHoldSec || 0),
    Math.max(0, zoomDurationSec - 0.001)
  )
  if (time >= zoomDurationSec) {
    return { x: 0, y: 0, w: outputWidth, h: outputHeight }
  }
  const start = zoomStartWindow(plan, geometry)
  if (time <= zoomHoldSec) return start
  const rawT = (time - zoomHoldSec) / Math.max(0.001, zoomDurationSec - zoomHoldSec)
  const t = clamp(rawT, 0, 1)
  const w = start.w * Math.pow(outputWidth / start.w, t)
  const h = start.h * Math.pow(outputHeight / start.h, t)
  const sizeT = clamp((w - start.w) / Math.max(0.001, outputWidth - start.w), 0, 1)
  return {
    x: start.x + (0 - start.x) * sizeT,
    y: start.y + (0 - start.y) * sizeT,
    w,
    h,
  }
}

export function intersects(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

export function screenRectForCell(assignment, window, plan, geometry = null) {
  const rect = cellRectFromPlan(assignment, plan, geometry)
  return {
    x: ((rect.x - window.x) / window.w) * plan.grid.outputWidth,
    y: ((rect.y - window.y) / window.h) * plan.grid.outputHeight,
    w: (rect.w / window.w) * plan.grid.outputWidth,
    h: (rect.h / window.h) * plan.grid.outputHeight,
  }
}

export function maxScreenSizeForCandidate(plan, candidateKey, geometry = null) {
  const candidateAssignments = plan.assignments.filter(
    (assignment) => assignment.candidateKey === candidateKey
  )
  let maxWidth = 1
  let maxHeight = 1
  const totalFrames = Math.max(1, Math.ceil(plan.timing.preRollSec * plan.timing.fps))
  for (let frame = 0; frame <= totalFrames; frame++) {
    const time = frame / plan.timing.fps
    const window = zoomWindow(time, plan, geometry)
    for (const assignment of candidateAssignments) {
      const rect = cellRectFromPlan(assignment, plan, geometry)
      if (!intersects(rect, window)) continue
      const screen = screenRectForCell(assignment, window, plan, geometry)
      maxWidth = Math.max(maxWidth, screen.w)
      maxHeight = Math.max(maxHeight, screen.h)
    }
  }
  return {
    width: Math.ceil(maxWidth),
    height: Math.ceil(maxHeight),
  }
}
