// Builds the resolution-independent hover hit-map shared by the dev-only /bake
// harness and the live "Publish" share flow. The contour-flow mosaic places
// tiles at polygon centers; this reduces those centers to a coarse cols×rows
// grid where each bucket records the source frame nearest that spot, so a viewer
// can map a normalized pointer position straight onto a tile (see `tileAt` in
// mosaic-gallery.tsx). Both producers must emit byte-identical maps, so the one
// implementation lives here.

import type { GalleryTile } from "./gallery"

// Frame-space granularity of the hit grid (px). Coarser than a mosaic cell so
// every bucket reliably contains a tile, but fine enough that moving the cursor
// reveals many different frames.
export const DEFAULT_HIT_CELL_PX = 22

export type HitMap = {
  cols: number
  rows: number
  // cols*rows buckets, each a compact index into `tiles`, or -1 when empty.
  grid: number[]
  tiles: GalleryTile[]
}

// `resolveTile` turns a tile id (an entry of `tileIds`) into the GalleryTile the
// hover popup shows. `assignment[i]` is the index into `tileIds` chosen for cell
// `i`; `centers` holds that cell's (x,y) in frame coordinates.
export function buildMosaicHitMap(opts: {
  frameW: number
  frameH: number
  centers: Float32Array
  assignment: Int32Array
  tileIds: string[]
  resolveTile: (id: string) => GalleryTile
  hitCellPx?: number
}): HitMap {
  const { frameW, frameH, centers, assignment, tileIds, resolveTile } = opts
  const hitCellPx = opts.hitCellPx ?? DEFAULT_HIT_CELL_PX

  const cols = Math.max(1, Math.round(frameW / hitCellPx))
  const rows = Math.max(1, Math.round(frameH / hitCellPx))
  const cellW = frameW / cols
  const cellH = frameH / rows

  // Per bucket, keep the cell whose center is nearest the bucket center.
  const bestDist = new Float64Array(cols * rows).fill(Infinity)
  const bucketAssign = new Int32Array(cols * rows).fill(-1)
  const cellCount = centers.length / 2
  for (let i = 0; i < cellCount; i++) {
    const cx = centers[i * 2]
    const cy = centers[i * 2 + 1]
    let gx = Math.floor(cx / cellW)
    let gy = Math.floor(cy / cellH)
    if (gx < 0) gx = 0
    else if (gx >= cols) gx = cols - 1
    if (gy < 0) gy = 0
    else if (gy >= rows) gy = rows - 1
    const b = gy * cols + gx
    const dx = cx - (gx + 0.5) * cellW
    const dy = cy - (gy + 0.5) * cellH
    const d = dx * dx + dy * dy
    if (d < bestDist[b]) {
      bestDist[b] = d
      bucketAssign[b] = assignment[i]
    }
  }

  // Compact to only the referenced frames so the map ships just the tiles it uses.
  const compact = new Map<number, number>()
  const tiles: GalleryTile[] = []
  const grid = new Array<number>(cols * rows)
  for (let b = 0; b < grid.length; b++) {
    const a = bucketAssign[b]
    if (a < 0) {
      grid[b] = -1
      continue
    }
    let ci = compact.get(a)
    if (ci === undefined) {
      const id = tileIds[a]
      tiles.push(resolveTile(id))
      ci = tiles.length - 1
      compact.set(a, ci)
    }
    grid[b] = ci
  }

  return { cols, rows, grid, tiles }
}
