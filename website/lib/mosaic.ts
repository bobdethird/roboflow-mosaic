// Photo-mosaic helpers: build an averaged-color signature for each of the
// reference's grid cells and for each tile photo, then pick the min-MSE tile per
// cell. These run on BOTH the main thread and inside the mosaic Web Worker, so
// they avoid `document` (preferring OffscreenCanvas) and accept either an
// HTMLImageElement (main thread) or an ImageBitmap (worker) as an image source.

export type Grid = { cols: number; rows: number }

// A rectangle in mosaic-content coordinates (the 0..width × 0..height frame).
export type Region = { x: number; y: number; w: number; h: number }

// A 2D context from either a DOM <canvas> or an OffscreenCanvas (worker-safe).
export type AnyCanvasContext =
  | CanvasRenderingContext2D
  | OffscreenCanvasRenderingContext2D

// Anything we can draw into a cell/signature: an ImageBitmap (decoded in the
// worker) or an HTMLImageElement (decoded on the main thread).
export type TileSource = HTMLImageElement | ImageBitmap

// Side length of the square color signature sampled per tile/cell. Larger is
// finer/more granular — closer to a pixel-for-pixel comparison (an NxN grid of
// average colors, MSE taken over N*N*3 values) at a higher matching cost.
export const SIGNATURE_GRID = 16

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error("Could not load image"))
    img.src = url
  })
}

// HTMLImageElement exposes naturalWidth/Height; ImageBitmap only width/height.
function sourceSize(img: TileSource): { w: number; h: number } {
  if ("naturalWidth" in img) {
    return { w: img.naturalWidth || img.width, h: img.naturalHeight || img.height }
  }
  return { w: img.width, h: img.height }
}

// Draw `img` to fill the destination rect, cropping the overflow (object-cover)
// so cells/signatures never letterbox or distort. Exported so the worker can
// paint individual cells while a mosaic generates progressively.
export function drawCover(
  ctx: AnyCanvasContext,
  img: TileSource,
  dx: number,
  dy: number,
  dw: number,
  dh: number
) {
  const { w: iw, h: ih } = sourceSize(img)
  if (!iw || !ih) return
  const imgRatio = iw / ih
  const dstRatio = dw / dh
  let sx = 0
  let sy = 0
  let sw = iw
  let sh = ih
  if (imgRatio > dstRatio) {
    // Source is wider than the cell — crop the sides.
    sw = ih * dstRatio
    sx = (iw - sw) / 2
  } else {
    // Source is taller — crop top and bottom.
    sh = iw / dstRatio
    sy = (ih - sh) / 2
  }
  // drawImage is identically shaped on both context types; the cast just sidesteps
  // a spurious "union of overloads" complaint from TypeScript.
  ;(ctx as CanvasRenderingContext2D).drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh)
}

// Create a 2D context backed by an OffscreenCanvas when available (works both in
// workers and on the main thread), falling back to a DOM canvas otherwise.
function createContext2d(width: number, height: number): AnyCanvasContext {
  if (typeof OffscreenCanvas !== "undefined") {
    const ctx = new OffscreenCanvas(width, height).getContext("2d", {
      willReadFrequently: true,
    })
    if (ctx) return ctx
  }
  if (typeof document !== "undefined") {
    const canvas = document.createElement("canvas")
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext("2d", { willReadFrequently: true })
    if (ctx) return ctx
  }
  throw new Error("2D canvas context unavailable")
}

// S*S*3 averaged-color signature. Drawing a large image into an SxS canvas lets
// the browser area-average each block, so the read-back pixels are the averages.
export function signatureOf(
  img: TileSource,
  s = SIGNATURE_GRID
): Float32Array {
  const ctx = createContext2d(s, s)
  drawCover(ctx, img, 0, 0, s, s)
  const { data } = ctx.getImageData(0, 0, s, s)
  const sig = new Float32Array(s * s * 3)
  for (let i = 0; i < s * s; i++) {
    sig[i * 3] = data[i * 4]
    sig[i * 3 + 1] = data[i * 4 + 1]
    sig[i * 3 + 2] = data[i * 4 + 2]
  }
  return sig
}

// One signature per grid cell from a single reference draw at (cols*s)x(rows*s).
export function referenceCellSignatures(
  ref: TileSource,
  grid: Grid,
  s = SIGNATURE_GRID
): Float32Array[] {
  const w = grid.cols * s
  const h = grid.rows * s
  const ctx = createContext2d(w, h)
  drawCover(ctx, ref, 0, 0, w, h)
  const { data } = ctx.getImageData(0, 0, w, h)
  const cells: Float32Array[] = []
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const sig = new Float32Array(s * s * 3)
      for (let yy = 0; yy < s; yy++) {
        for (let xx = 0; xx < s; xx++) {
          const px = ((row * s + yy) * w + (col * s + xx)) * 4
          const k = (yy * s + xx) * 3
          sig[k] = data[px]
          sig[k + 1] = data[px + 1]
          sig[k + 2] = data[px + 2]
        }
      }
      cells.push(sig)
    }
  }
  return cells
}

// Per-tile color signatures for an arbitrary set of tile centers (used by the
// contour-flow layout, whose tiles aren't on a grid). The reference is drawn
// once into a buffer scaled so a `size`×`size` tile window maps to s×s buffer
// pixels, then each tile reads its s×s block straight out of that buffer — far
// cheaper than one canvas draw per tile. Sampling is axis-aligned (it ignores
// the tile's rotation), which is fine for a coarse average-color signature.
export function referenceWindowSignatures(
  ref: TileSource,
  centers: ArrayLike<number>,
  size: number,
  width: number,
  height: number,
  s = SIGNATURE_GRID
): Float32Array[] {
  const n = centers.length / 2
  const scale = s / Math.max(1, size)
  const bw = Math.max(s, Math.round(width * scale))
  const bh = Math.max(s, Math.round(height * scale))
  const ctx = createContext2d(bw, bh)
  drawCover(ctx, ref, 0, 0, bw, bh)
  const { data } = ctx.getImageData(0, 0, bw, bh)
  const clampI = (v: number, hi: number) => (v < 0 ? 0 : v > hi ? hi : v)
  const half = s / 2
  const out: Float32Array[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const bx = centers[i * 2] * scale - half
    const by = centers[i * 2 + 1] * scale - half
    const sx0 = Math.round(bx)
    const sy0 = Math.round(by)
    const sig = new Float32Array(s * s * 3)
    for (let yy = 0; yy < s; yy++) {
      const py = clampI(sy0 + yy, bh - 1)
      for (let xx = 0; xx < s; xx++) {
        const px = clampI(sx0 + xx, bw - 1)
        const di = (py * bw + px) * 4
        const k = (yy * s + xx) * 3
        sig[k] = data[di]
        sig[k + 1] = data[di + 1]
        sig[k + 2] = data[di + 2]
      }
    }
    out[i] = sig
  }
  return out
}

// Minimum Sobel gradient magnitude (on the coarse cols×rows luminance grid)
// before a cell counts as "on an edge". Below it the local direction is mostly
// noise, so the tile is left axis-aligned (angle 0).
const EDGE_MIN = 16

// Per-cell stroke orientation in radians, derived from the reference's edges. A
// Sobel gradient is taken over a cols×rows luminance grid and each tile is
// aligned ALONG the local contour (perpendicular to the gradient). Flat areas
// resolve to 0 so only real edges steer the tiles.
export function referenceCellOrientations(
  ref: TileSource,
  grid: Grid
): Float32Array {
  const { cols, rows } = grid
  const ctx = createContext2d(cols, rows)
  drawCover(ctx, ref, 0, 0, cols, rows)
  const { data } = ctx.getImageData(0, 0, cols, rows)
  const lum = new Float32Array(cols * rows)
  for (let i = 0; i < cols * rows; i++) {
    lum[i] =
      0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
  }
  const at = (x: number, y: number) => {
    const cx = x < 0 ? 0 : x >= cols ? cols - 1 : x
    const cy = y < 0 ? 0 : y >= rows ? rows - 1 : y
    return lum[cy * cols + cx]
  }
  const angles = new Float32Array(cols * rows)
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const gx =
        at(x + 1, y - 1) +
        2 * at(x + 1, y) +
        at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))
      const gy =
        at(x - 1, y + 1) +
        2 * at(x, y + 1) +
        at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))
      const mag = Math.hypot(gx, gy)
      angles[y * cols + x] =
        mag > EDGE_MIN ? Math.atan2(gy, gx) + Math.PI / 2 : 0
    }
  }
  return angles
}

// Average color of the reference (its mean pixel), used as the mosaic's grout /
// background so the gaps between tiles sit on-palette. Squishing the whole image
// into a single pixel lets the browser area-average every pixel for us.
export function averageColor(img: TileSource): string {
  const ctx = createContext2d(1, 1)
  ;(ctx as CanvasRenderingContext2D).drawImage(img, 0, 0, 1, 1)
  const { data } = ctx.getImageData(0, 0, 1, 1)
  return `rgb(${data[0]}, ${data[1]}, ${data[2]})`
}

// A normalized (0..1) Sobel edge-magnitude field of the reference at fw×fh. The
// Voronoi seeder uses it to push seeds out of edges so the cell borders settle
// along the photo's contours.
export type EdgeField = { mag: Float32Array; fw: number; fh: number }

export function edgeMagnitudeField(
  ref: TileSource,
  fw: number,
  fh: number
): EdgeField {
  const ctx = createContext2d(fw, fh)
  drawCover(ctx, ref, 0, 0, fw, fh)
  const { data } = ctx.getImageData(0, 0, fw, fh)
  const lum = new Float32Array(fw * fh)
  for (let i = 0; i < fw * fh; i++) {
    lum[i] =
      0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
  }
  const at = (x: number, y: number) => {
    const cx = x < 0 ? 0 : x >= fw ? fw - 1 : x
    const cy = y < 0 ? 0 : y >= fh ? fh - 1 : y
    return lum[cy * fw + cx]
  }
  const mag = new Float32Array(fw * fh)
  let max = 1e-6
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const gx =
        at(x + 1, y - 1) +
        2 * at(x + 1, y) +
        at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))
      const gy =
        at(x - 1, y + 1) +
        2 * at(x, y + 1) +
        at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))
      const m = Math.hypot(gx, gy)
      mag[y * fw + x] = m
      if (m > max) max = m
    }
  }
  for (let i = 0; i < mag.length; i++) mag[i] /= max
  return { mag, fw, fh }
}

// Like `EdgeField` but also retains the per-pixel gradient direction. The
// contour-flow layout needs the direction (not just the strength) so it can lay
// tiles tangent to the photo's edges.
export type EdgeVectorField = {
  mag: Float32Array
  // Gradient direction in radians (atan2(gy, gx)). The contour tangent — the
  // way a tile should point to run ALONG the edge — is this plus π/2.
  dir: Float32Array
  fw: number
  fh: number
}

export function edgeVectorField(
  ref: TileSource,
  fw: number,
  fh: number
): EdgeVectorField {
  const ctx = createContext2d(fw, fh)
  drawCover(ctx, ref, 0, 0, fw, fh)
  const { data } = ctx.getImageData(0, 0, fw, fh)
  const lum = new Float32Array(fw * fh)
  for (let i = 0; i < fw * fh; i++) {
    lum[i] =
      0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]
  }
  const at = (x: number, y: number) => {
    const cx = x < 0 ? 0 : x >= fw ? fw - 1 : x
    const cy = y < 0 ? 0 : y >= fh ? fh - 1 : y
    return lum[cy * fw + cx]
  }
  const mag = new Float32Array(fw * fh)
  const dir = new Float32Array(fw * fh)
  let max = 1e-6
  for (let y = 0; y < fh; y++) {
    for (let x = 0; x < fw; x++) {
      const gx =
        at(x + 1, y - 1) +
        2 * at(x + 1, y) +
        at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1))
      const gy =
        at(x - 1, y + 1) +
        2 * at(x, y + 1) +
        at(x + 1, y + 1) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1))
      const m = Math.hypot(gx, gy)
      mag[y * fw + x] = m
      dir[y * fw + x] = Math.atan2(gy, gx)
      if (m > max) max = m
    }
  }
  for (let i = 0; i < mag.length; i++) mag[i] /= max
  return { mag, dir, fw, fh }
}

export function mse(a: Float32Array, b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i]
    sum += d * d
  }
  return sum / a.length
}

// For each cell, the index of the tile with the lowest MSE. Tiles are reused
// freely (a tile may fill many cells), which is required when cells outnumber
// the uploaded photos.
export function assignTiles(
  cellSigs: Float32Array[],
  tileSigs: Float32Array[]
): number[] {
  return cellSigs.map((cell) => {
    let best = 0
    let bestErr = Infinity
    for (let t = 0; t < tileSigs.length; t++) {
      const err = mse(cell, tileSigs[t])
      if (err < bestErr) {
        bestErr = err
        best = t
      }
    }
    return best
  })
}

export function gridForCellSize(
  cellPx: number,
  width: number,
  height: number
): Grid {
  return {
    cols: Math.max(1, Math.round(width / cellPx)),
    rows: Math.max(1, Math.round(height / cellPx)),
  }
}

// Paint every assigned tile, cover-cropped to fill its cell. Cell edges are
// rounded to whole pixels so the grid tiles seamlessly with no hairlines.
export function drawMosaic(
  ctx: AnyCanvasContext,
  grid: Grid,
  assignment: ArrayLike<number>,
  tiles: ReadonlyArray<TileSource | null | undefined>,
  width: number,
  height: number
) {
  drawMosaicRegion(ctx, grid, assignment, tiles, width, height, {
    x: 0,
    y: 0,
    w: width,
    h: height,
  })
}

// Like `drawMosaic`, but only paints the cells overlapping `region`. The caller
// is expected to have applied the pan/zoom transform to `ctx` already, so tiles
// are drawn from their source at the displayed size. Restricting to the visible
// region keeps the work (and memory) bounded no matter the zoom level.
export function drawMosaicRegion(
  ctx: AnyCanvasContext,
  grid: Grid,
  assignment: ArrayLike<number>,
  tiles: ReadonlyArray<TileSource | null | undefined>,
  width: number,
  height: number,
  region: Region
) {
  const cw = width / grid.cols
  const ch = height / grid.rows
  const colStart = Math.max(0, Math.floor(region.x / cw))
  const colEnd = Math.min(grid.cols - 1, Math.floor((region.x + region.w) / cw))
  const rowStart = Math.max(0, Math.floor(region.y / ch))
  const rowEnd = Math.min(grid.rows - 1, Math.floor((region.y + region.h) / ch))
  if (colEnd < colStart || rowEnd < rowStart) return
  for (let row = rowStart; row <= rowEnd; row++) {
    for (let col = colStart; col <= colEnd; col++) {
      const tile = tiles[assignment[row * grid.cols + col]]
      if (!tile) continue
      const x = Math.round(col * cw)
      const y = Math.round(row * ch)
      const w = Math.round((col + 1) * cw) - x
      const h = Math.round((row + 1) * ch) - y
      drawCover(ctx, tile, x, y, w, h)
    }
  }
}

// Gap between tiles (fraction each shrinks toward its center) and the soft drop
// shadow that makes every tile read as a raised mosaic piece.
const TILE_GAP = 0.125
const TILE_EDGE_EPS = 0.01
const TILE_SHADOW_COLOR = "rgba(0, 0, 0, 0.32)"
const TILE_SHADOW_BLUR = 0.12 // × tile size
const TILE_SHADOW_OFFSET = 0.05 // × tile size

// Fill one Voronoi cell with its photo. Polygons are packed flat: cell `i` owns
// the vertices `offsets[i]..offsets[i+1]` in `polys` (as x,y pairs). We shrink
// the polygon toward its centroid (a grout gap), cast a soft offset shadow so
// the tile looks raised, then clip to it and cover-fill with the rotated photo.
// The cover square spans the polygon so it still covers it after rotation.
export function drawPolygonCell(
  ctx: AnyCanvasContext,
  polys: ArrayLike<number>,
  offsets: ArrayLike<number>,
  i: number,
  img: TileSource,
  angle: number,
  frame?: { width: number; height: number }
) {
  const start = offsets[i]
  const end = offsets[i + 1]
  const n = end - start
  if (n < 3) return
  let sx = 0
  let sy = 0
  for (let v = start; v < end; v++) {
    sx += polys[v * 2]
    sy += polys[v * 2 + 1]
  }
  const mx = sx / n
  const my = sy / n
  // Inset each vertex toward the centroid for the grout gap, but keep any vertex
  // on the outer frame pinned so grout only appears between tiles, not as a border.
  const k = 1 - TILE_GAP
  const ix: number[] = new Array(n)
  const iy: number[] = new Array(n)
  let maxDist = 0
  for (let j = 0; j < n; j++) {
    const x = polys[(start + j) * 2]
    const y = polys[(start + j) * 2 + 1]
    const frameWidth = frame?.width
    const frameHeight = frame?.height
    const onLeft = frameWidth !== undefined && x <= TILE_EDGE_EPS
    const onTop = frameHeight !== undefined && y <= TILE_EDGE_EPS
    const onRight =
      frameWidth !== undefined && Math.abs(x - frameWidth) <= TILE_EDGE_EPS
    const onBottom =
      frameHeight !== undefined && Math.abs(y - frameHeight) <= TILE_EDGE_EPS
    const onFrame = onLeft || onTop || onRight || onBottom
    const px = onFrame
      ? onLeft
        ? 0
        : onRight
          ? frameWidth
          : x
      : mx + (x - mx) * k
    const py = onFrame
      ? onTop
        ? 0
        : onBottom
          ? frameHeight
          : y
      : my + (y - my) * k
    ix[j] = px
    iy[j] = py
    const d = Math.hypot(px - mx, py - my)
    if (d > maxDist) maxDist = d
  }
  const cover = maxDist * 2
  const c = ctx as CanvasRenderingContext2D
  const trace = () => {
    c.beginPath()
    c.moveTo(ix[0], iy[0])
    for (let j = 1; j < n; j++) c.lineTo(ix[j], iy[j])
    c.closePath()
  }

  // Shadow pass: a filled polygon with a soft offset shadow. The fill is hidden
  // by the image below; only the shadow spilling into the gap stays visible.
  c.save()
  c.shadowColor = TILE_SHADOW_COLOR
  c.shadowBlur = cover * TILE_SHADOW_BLUR
  c.shadowOffsetX = cover * TILE_SHADOW_OFFSET
  c.shadowOffsetY = cover * TILE_SHADOW_OFFSET
  trace()
  c.fillStyle = "#000"
  c.fill()
  c.restore()

  // Image pass: clip to the inset polygon and cover-fill with the rotated photo.
  c.save()
  trace()
  c.clip()
  c.translate(mx, my)
  if (angle) c.rotate(angle)
  drawCover(ctx, img, -cover / 2, -cover / 2, cover, cover)
  c.restore()
}

// Voronoi variant of `drawMosaicRegion`: every cell is a polygon (triangle …
// hexagon) that tessellates, filled with its matched photo rotated to the cell's
// edge orientation. Cells are seeded from the grid, so we cull by grid cell
// (widened generously, since a Voronoi cell can spill past its seed's cell).
export function drawPolygonMosaicRegion(
  ctx: AnyCanvasContext,
  grid: Grid,
  assignment: ArrayLike<number>,
  angles: ArrayLike<number>,
  tiles: ReadonlyArray<TileSource | null | undefined>,
  width: number,
  height: number,
  region: Region,
  polys: ArrayLike<number>,
  offsets: ArrayLike<number>
) {
  const { cols, rows } = grid
  const cw = width / cols
  const ch = height / rows
  const colStart = Math.max(0, Math.floor(region.x / cw) - 2)
  const colEnd = Math.min(cols - 1, Math.floor((region.x + region.w) / cw) + 2)
  const rowStart = Math.max(0, Math.floor(region.y / ch) - 2)
  const rowEnd = Math.min(rows - 1, Math.floor((region.y + region.h) / ch) + 2)
  if (colEnd < colStart || rowEnd < rowStart) return
  for (let row = rowStart; row <= rowEnd; row++) {
    for (let col = colStart; col <= colEnd; col++) {
      const idx = row * cols + col
      const tile = tiles[assignment[idx]]
      if (!tile) continue
      drawPolygonCell(ctx, polys, offsets, idx, tile, angles[idx], {
        width,
        height,
      })
    }
  }
}

// Like `drawPolygonMosaicRegion`, but for the contour-flow layout whose tiles
// are NOT on a grid (their count and positions are free). Culling is by each
// tile's center against the region, widened by `extent` (≈ a tile's reach) so
// tiles whose center sits just outside still paint into the view. Cheap enough
// to scan every tile since the overlay only repaints once a gesture settles.
export function drawTileMosaicRegion(
  ctx: AnyCanvasContext,
  assignment: ArrayLike<number>,
  angles: ArrayLike<number>,
  tiles: ReadonlyArray<TileSource | null | undefined>,
  region: Region,
  polys: ArrayLike<number>,
  offsets: ArrayLike<number>,
  centers: ArrayLike<number>,
  extent: number,
  frame?: { width: number; height: number }
) {
  const n = centers.length / 2
  const minX = region.x - extent
  const maxX = region.x + region.w + extent
  const minY = region.y - extent
  const maxY = region.y + region.h + extent
  for (let i = 0; i < n; i++) {
    const x = centers[i * 2]
    const y = centers[i * 2 + 1]
    if (x < minX || x > maxX || y < minY || y > maxY) continue
    const tile = tiles[assignment[i]]
    if (!tile) continue
    drawPolygonCell(ctx, polys, offsets, i, tile, angles[i], frame)
  }
}
