// Contour-flow ("andamento") tile placement — how a human mosaicist actually
// works. Three stages:
//
//   1. Seeds are laid ALONG the reference's contours: walk the strong edges and
//      drop a seed every tile-step, each oriented tangent to the edge.
//   2. The rest of the frame is filled by growing OUTWARD from the seeds placed
//      so far: every seed spawns neighbours alongside and beside it, inheriting
//      its flow direction (snapping back to a contour where one is near). A
//      breadth-first wavefront from the contour seeds fills the plane with rows
//      that run parallel to the edges — exactly the look of opus vermiculatum. A
//      short relaxation then settles the seeds onto a locally-square lattice so
//      the resulting tiles' corners come out close to 90°.
//   3. Each tile's SHAPE is the Voronoi cell of its seed (clipped against nearby
//      seeds), then simplified toward a quadrilateral: corners are dropped
//      shallowest-first until the cell is a quad, but a corner sharper than a
//      budget is spared (so it stays a pentagon rather than gouging a gap), and a
//      near-flat corner collapses to a triangle. Edges sit at the natural angles
//      between neighbours, so quadrilaterals dominate with triangles and
//      pentagons mixed in — and because every cell stays a subset of its Voronoi
//      cell, tiles never overlap.
//
// The output is the same packed-polygon format the renderer already consumes
// (`polys` + `offsets`), plus per-tile `angles` and `centers`, so nothing
// downstream needs to know these tiles came from a flow instead of a grid.

import type { EdgeVectorField } from "./mosaic"

export type ContourTiles = {
  polys: Float32Array
  offsets: Int32Array
  angles: Float32Array
  // Tile centers (x,y pairs) — used to sample per-tile color signatures and to
  // cull tiles to the visible region when repainting the crisp overlay.
  centers: Float32Array
  count: number
  tileSize: number
  // Largest distance from a tile's center to any of its polygon vertices, so the
  // overlay can cull cells (which, unlike squares, vary in reach) correctly.
  extent: number
}

// Normalized edge strength a pixel needs before it seeds a contour tile.
const CONTOUR_MAG = 0.17
// During growth, snap a tile back onto the local contour tangent when the edge
// here is at least this strong; otherwise it inherits its parent's direction.
const SNAP_MAG = 0.13
// Rejection radius (× tile size): a candidate is dropped if an existing tile is
// nearer than this, which both prevents pile-ups and sets the packing tightness.
const MIN_DIST_FRAC = 0.74
// Seed jitter (× tile size) applied before tessellating, so flat regions break
// out of a perfectly regular lattice into varied, organic quads. Kept small so
// it doesn't undo the squaring-up relaxation below.
const JITTER = 0.07
// Before tessellating, seeds are relaxed onto a locally-square lattice so tile
// corners come out near 90°: each pass nudges a seed (at RELAX_RATE) toward where
// its nearest neighbour in each flow-frame direction would sit one step away
// on-axis. Displacement from the contour-placed home is capped (× tile size) so
// the flow and edges are preserved. RELAX_ITERS = 0 disables the pass.
const RELAX_ITERS = 6
const RELAX_RATE = 0.5
const RELAX_MAX_DISP = 0.7
// Hard cap on a tile's side count: a cell with this many genuinely-sharp corners
// (a rare true hexagon) loses its least-defining one, becoming a pentagon.
const MAX_SIDES = 5
// Quad target: when reducing a 5+-gon toward a quadrilateral we may drop a corner
// only if its vertex sits closer than this (× tile size) to the line between its
// neighbours. So most cells collapse to quads, but a cell whose extra corner is
// SHARPER than this keeps it as a pentagon instead of carving a big gap. This is
// the main dial: larger ⇒ more quads (and larger slivers where a corner drops),
// smaller ⇒ more pentagons but tighter fit.
const QUAD_DEV_FRAC = 0.26
// A corner shallower than this (× tile) is a negligible bevel, dropped even from
// a quad — this is what yields the occasional triangle where a side is near-flat.
const FLAT_DEV_FRAC = 0.07
// Chaikin corner-cutting passes used to curve the cell edges. 0 = hard polygons,
// 2 = soft curved quadrilaterals. More passes = rounder (and more vertices).
const CURVE_ITERS = 0

// Fold an angle into (−π/2, π/2] so a bare contour tangent yields an upright-ish
// tile. Growth uses `alignAngle` instead to keep neighbours continuous.
function normAngle(a: number): number {
  const pi = Math.PI
  let r = a % pi
  if (r <= -pi / 2) r += pi
  else if (r > pi / 2) r -= pi
  return r
}

// Bring `target` (a line direction, periodic by π) to within ±π/2 of `ref` so
// adjacent tiles in a flow keep nearly the same rotation instead of flipping.
function alignAngle(target: number, ref: number): number {
  const pi = Math.PI
  let t = target
  while (t - ref > pi / 2) t -= pi
  while (t - ref < -pi / 2) t += pi
  return t
}

type Pt = [number, number]

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Keep the part of `poly` inside the half-plane a*x + b*y <= c (one Voronoi
// bisector). Sutherland–Hodgman against a single edge.
function clipHalfPlane(poly: Pt[], a: number, b: number, c: number): Pt[] {
  const out: Pt[] = []
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const A = poly[i]
    const B = poly[(i + 1) % n]
    const da = a * A[0] + b * A[1] - c
    const db = a * B[0] + b * B[1] - c
    const ain = da <= 0
    const bin = db <= 0
    if (ain) out.push(A)
    if (ain !== bin) {
      const t = da / (da - db)
      out.push([A[0] + t * (B[0] - A[0]), A[1] + t * (B[1] - A[1])])
    }
  }
  return out
}

// Perpendicular distance from vertex `b` to the line through its neighbours `a`
// and `c` — how far the corner bulges out of the chord, i.e. how "real" it is. A
// near-collinear (flat) corner returns ~0.
function cornerDeviation(a: Pt, b: Pt, c: Pt): number {
  const ex = c[0] - a[0]
  const ey = c[1] - a[1]
  const len = Math.hypot(ex, ey)
  if (len < 1e-9) return 0
  return Math.abs((b[0] - a[0]) * ey - (b[1] - a[1]) * ex) / len
}

// Index of the shallowest corner (the least-defining one, whose vertex is
// closest to the chord between its neighbours), or -1 if none is below `limit`.
function shallowestCorner(p: Pt[], limit: number): number {
  const n = p.length
  let idx = -1
  let min = limit
  for (let i = 0; i < n; i++) {
    const dev = cornerDeviation(p[(i - 1 + n) % n], p[i], p[(i + 1) % n])
    if (dev < min) {
      min = dev
      idx = i
    }
  }
  return idx
}

// Simplify a convex Voronoi cell toward a quadrilateral while keeping it space-
// filling. Each pass drops the shallowest qualifying corner — the least-defining
// one, so the sliver left behind is smallest. Three stages:
//   1. Drive toward a quad: drop corners shallower than `quadDev`, so most cells
//      become quadrilaterals; a 5+-gon whose extra corner is sharper than that is
//      left alone rather than gouged into a big gap.
//   2. Hard-cap at `maxSides`, dropping the least-defining corner even if sharp
//      (a rare all-sharp hexagon becomes a pentagon).
//   3. Collapse a near-flat corner (below `flatDev`) so a barely-bent quad reads
//      as the triangle it nearly is.
// Net: quadrilaterals dominate, with pentagons only where a corner is genuinely
// sharp and triangles where one is genuinely flat.
function simplifyCell(
  poly: Pt[],
  maxSides: number,
  quadDev: number,
  flatDev: number
): Pt[] {
  let p = poly
  while (p.length > 4) {
    const idx = shallowestCorner(p, quadDev)
    if (idx < 0) break
    p = p.slice(0, idx).concat(p.slice(idx + 1))
  }
  while (p.length > maxSides) {
    const idx = shallowestCorner(p, Infinity)
    p = p.slice(0, idx).concat(p.slice(idx + 1))
  }
  while (p.length > 3) {
    const idx = shallowestCorner(p, flatDev)
    if (idx < 0) break
    p = p.slice(0, idx).concat(p.slice(idx + 1))
  }
  return p
}

// Chaikin corner-cutting on a closed ring: replace each vertex with two points a
// quarter and three-quarters along its edges, rounding the corners. Repeated, it
// converges to a smooth curve while staying inside the original polygon.
function chaikin(ring: Pt[], iters: number): Pt[] {
  let poly = ring
  for (let it = 0; it < iters; it++) {
    const n = poly.length
    if (n < 3) break
    const out: Pt[] = new Array(n * 2)
    for (let i = 0; i < n; i++) {
      const A = poly[i]
      const B = poly[(i + 1) % n]
      out[i * 2] = [A[0] * 0.75 + B[0] * 0.25, A[1] * 0.75 + B[1] * 0.25]
      out[i * 2 + 1] = [A[0] * 0.25 + B[0] * 0.75, A[1] * 0.25 + B[1] * 0.75]
    }
    poly = out
  }
  return poly
}

export function contourMosaic(
  width: number,
  height: number,
  tileSize: number,
  field: EdgeVectorField
): ContourTiles {
  const { mag, dir, fw, fh } = field
  const s = Math.max(2, tileSize)
  const minDist = MIN_DIST_FRAC * s
  const minDist2 = minDist * minDist
  const maxTiles =
    Math.ceil(width / s) * Math.ceil(height / s) * 2 + 64

  // Placed tiles, grown in place.
  const cx: number[] = []
  const cy: number[] = []
  const ang: number[] = []

  // Uniform spatial hash (cell = s) so neighbour queries during placement stay
  // O(1). Centers are always in [0,width]×[0,height], so cell indices are ≥ 0.
  const inv = 1 / s
  // Vertical stride larger than any row index so the ±1 neighbour halo (which
  // probes gx = −1 / gy = −1) can't alias a real cell in an adjacent row. The
  // key is collision-free for gx ≥ −1 and gy ∈ [−1, gh − 2].
  const gh = Math.ceil(height / s) + 4
  const hash = new Map<number, number[]>()
  const keyOf = (gx: number, gy: number) => (gx + 1) * gh + (gy + 1)
  const cellGx = (x: number) => (x * inv) | 0
  const cellGy = (y: number) => (y * inv) | 0

  // Nearest-sample the field at canvas coords.
  const fxs = fw / width
  const fys = fh / height
  const fieldIdx = (x: number, y: number) => {
    let ix = (x * fxs) | 0
    let iy = (y * fys) | 0
    if (ix < 0) ix = 0
    else if (ix >= fw) ix = fw - 1
    if (iy < 0) iy = 0
    else if (iy >= fh) iy = fh - 1
    return iy * fw + ix
  }
  const magAt = (x: number, y: number) => mag[fieldIdx(x, y)]
  const tangentAt = (x: number, y: number) =>
    normAngle(dir[fieldIdx(x, y)] + Math.PI / 2)

  const canPlace = (x: number, y: number): boolean => {
    if (x < 0 || x > width || y < 0 || y > height) return false
    const gx = cellGx(x)
    const gy = cellGy(y)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = hash.get(keyOf(gx + dx, gy + dy))
        if (!list) continue
        for (let li = 0; li < list.length; li++) {
          const j = list[li]
          const ddx = cx[j] - x
          const ddy = cy[j] - y
          if (ddx * ddx + ddy * ddy < minDist2) return false
        }
      }
    }
    return true
  }

  const place = (x: number, y: number, th: number): number => {
    const i = cx.length
    cx.push(x)
    cy.push(y)
    ang.push(th)
    const k = keyOf(cellGx(x), cellGy(y))
    let list = hash.get(k)
    if (!list) {
      list = []
      hash.set(k, list)
    }
    list.push(i)
    return i
  }

  // Angle of the closest existing tile (searching outward in hash rings), so a
  // gap-filling tile blends into whatever flow surrounds it.
  const nearestAngle = (x: number, y: number): number => {
    const gx = cellGx(x)
    const gy = cellGy(y)
    for (let r = 1; r <= 3; r++) {
      let best = -1
      let bestD = Infinity
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const list = hash.get(keyOf(gx + dx, gy + dy))
          if (!list) continue
          for (let li = 0; li < list.length; li++) {
            const j = list[li]
            const ddx = cx[j] - x
            const ddy = cy[j] - y
            const d = ddx * ddx + ddy * ddy
            if (d < bestD) {
              bestD = d
              best = j
            }
          }
        }
      }
      if (best >= 0) return ang[best]
    }
    return 0
  }

  // ---- Phase 1: lay tiles along the contours ---------------------------------
  // Visit edge pixels strongest-first so the boldest contours seed before
  // weaker ones; spacing rejection thins each edge into a single tile chain.
  const seeds: number[] = []
  for (let i = 0; i < mag.length; i++) {
    if (mag[i] > CONTOUR_MAG) seeds.push(i)
  }
  seeds.sort((a, b) => mag[b] - mag[a])
  const frontier: number[] = []
  for (let si = 0; si < seeds.length && cx.length < maxTiles; si++) {
    const p = seeds[si]
    const px = p % fw
    const py = (p - px) / fw
    const x = (px + 0.5) / fw * width
    const y = (py + 0.5) / fh * height
    if (!canPlace(x, y)) continue
    frontier.push(place(x, y, tangentAt(x, y)))
  }

  // ---- Phase 2: grow outward from the tiles placed so far --------------------
  // A breadth-first wavefront. Each tile offers four neighbours: two continuing
  // its row (±along) and two starting the adjacent rows (±across). New tiles
  // inherit the parent's direction, re-snapping to a contour where one is near,
  // so rows stay parallel to the edges and bend with them.
  for (let head = 0; head < frontier.length && cx.length < maxTiles; head++) {
    const i = frontier[head]
    const x = cx[i]
    const y = cy[i]
    const th = ang[i]
    const ax = Math.cos(th) * s
    const ay = Math.sin(th) * s
    const bx = -Math.sin(th) * s
    const by = Math.cos(th) * s
    const cand = [
      [x + ax, y + ay],
      [x - ax, y - ay],
      [x + bx, y + by],
      [x - bx, y - by],
    ]
    for (let c = 0; c < 4; c++) {
      const nx = cand[c][0]
      const ny = cand[c][1]
      if (!canPlace(nx, ny)) continue
      const nth =
        magAt(nx, ny) > SNAP_MAG ? alignAngle(tangentAt(nx, ny), th) : th
      frontier.push(place(nx, ny, nth))
      if (cx.length >= maxTiles) break
    }
  }

  // ---- Phase 3: sweep for any holes the wavefront left behind -----------------
  // A staggered scan at tile spacing places a tile wherever there's still room,
  // taking its direction from the nearest neighbour so it joins the local flow.
  if (cx.length < maxTiles) {
    let rowParity = 0
    for (let y = s * 0.5; y <= height; y += s) {
      const offset = rowParity ? s * 0.5 : 0
      for (let x = s * 0.5 + offset; x <= width; x += s) {
        if (cx.length >= maxTiles) break
        if (!canPlace(x, y)) continue
        const th = magAt(x, y) > SNAP_MAG ? tangentAt(x, y) : nearestAngle(x, y)
        place(x, y, th)
      }
      rowParity ^= 1
    }
  }

  // ---- Relax seeds toward a locally-square lattice ---------------------------
  // A tile's corners read as ~90° only when its four neighbours sit squarely
  // along its flow frame (±along, ±across). Placement gets close, but colliding
  // growth fronts, contour chains and the hole sweep leave seeds skewed off that
  // grid. Each pass nudges a seed toward the average of where its nearest
  // neighbour in every frame direction would sit one step away on-axis — squaring
  // up the neighbourhood, and so the Voronoi cell's angles — then refreshes the
  // hash. A cap keeps seeds near where the contours originally placed them.
  if (RELAX_ITERS > 0) {
    const homeX = cx.slice()
    const homeY = cy.slice()
    const relaxCap = RELAX_MAX_DISP * s
    const rr = 2
    const tcx = new Array<number>(cx.length)
    const tcy = new Array<number>(cx.length)
    for (let it = 0; it < RELAX_ITERS; it++) {
      for (let i = 0; i < cx.length; i++) {
        const xi = cx[i]
        const yi = cy[i]
        const th = ang[i]
        const ux = Math.cos(th)
        const uy = Math.sin(th)
        const vx = -uy
        const vy = ux
        // Nearest neighbour (by distance) in each of the four frame directions.
        let dPU = Infinity
        let dMU = Infinity
        let dPV = Infinity
        let dMV = Infinity
        let pUx = 0
        let pUy = 0
        let mUx = 0
        let mUy = 0
        let pVx = 0
        let pVy = 0
        let mVx = 0
        let mVy = 0
        const gx = cellGx(xi)
        const gy = cellGy(yi)
        for (let dy = -rr; dy <= rr; dy++) {
          for (let dx = -rr; dx <= rr; dx++) {
            const list = hash.get(keyOf(gx + dx, gy + dy))
            if (!list) continue
            for (let li = 0; li < list.length; li++) {
              const j = list[li]
              if (j === i) continue
              const rx = cx[j] - xi
              const ry = cy[j] - yi
              const r2 = rx * rx + ry * ry
              if (r2 < 1e-9) continue
              const pu = rx * ux + ry * uy
              const pv = rx * vx + ry * vy
              if (Math.abs(pu) >= Math.abs(pv)) {
                if (pu >= 0) {
                  if (r2 < dPU) {
                    dPU = r2
                    pUx = cx[j]
                    pUy = cy[j]
                  }
                } else if (r2 < dMU) {
                  dMU = r2
                  mUx = cx[j]
                  mUy = cy[j]
                }
              } else if (pv >= 0) {
                if (r2 < dPV) {
                  dPV = r2
                  pVx = cx[j]
                  pVy = cy[j]
                }
              } else if (r2 < dMV) {
                dMV = r2
                mVx = cx[j]
                mVy = cy[j]
              }
            }
          }
        }
        let sx = 0
        let sy = 0
        let cnt = 0
        if (dPU < Infinity) {
          sx += pUx - s * ux
          sy += pUy - s * uy
          cnt++
        }
        if (dMU < Infinity) {
          sx += mUx + s * ux
          sy += mUy + s * uy
          cnt++
        }
        if (dPV < Infinity) {
          sx += pVx - s * vx
          sy += pVy - s * vy
          cnt++
        }
        if (dMV < Infinity) {
          sx += mVx + s * vx
          sy += mVy + s * vy
          cnt++
        }
        if (cnt === 0) {
          tcx[i] = xi
          tcy[i] = yi
          continue
        }
        let mx = xi + RELAX_RATE * (sx / cnt - xi)
        let my = yi + RELAX_RATE * (sy / cnt - yi)
        // Cap displacement from the contour-placed home.
        const ex = mx - homeX[i]
        const ey = my - homeY[i]
        const e2 = ex * ex + ey * ey
        if (e2 > relaxCap * relaxCap) {
          const f = relaxCap / Math.sqrt(e2)
          mx = homeX[i] + ex * f
          my = homeY[i] + ey * f
        }
        tcx[i] = Math.min(width, Math.max(0, mx))
        tcy[i] = Math.min(height, Math.max(0, my))
      }
      for (let i = 0; i < cx.length; i++) {
        cx[i] = tcx[i]
        cy[i] = tcy[i]
      }
      // Refresh the spatial hash so the next pass — and the tessellation below —
      // query neighbours at their new positions.
      hash.clear()
      for (let i = 0; i < cx.length; i++) {
        const k = keyOf(cellGx(cx[i]), cellGy(cy[i]))
        let list = hash.get(k)
        if (!list) {
          list = []
          hash.set(k, list)
        }
        list.push(i)
      }
    }
  }

  // ---- Jitter the seeds so the tessellation varies into organic quads --------
  const n = cx.length
  const jx = new Float32Array(n)
  const jy = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const rng = mulberry32((Math.imul(i + 1, 2654435761) ^ 0x9e3779b9) >>> 0)
    jx[i] = Math.min(width, Math.max(0, cx[i] + (rng() * 2 - 1) * JITTER * s))
    jy[i] = Math.min(height, Math.max(0, cy[i] + (rng() * 2 - 1) * JITTER * s))
  }

  // ---- Voronoi cell per seed, simplified toward a quad -----------------------
  // Clip a generous box against the perpendicular bisectors of nearby seeds
  // (found through the same spatial hash used during placement). That yields the
  // exact Voronoi cell — a polygon whose edges sit at the natural angles between
  // neighbours and that tessellates with no gaps and no overlaps. Then simplify
  // it toward a quad: a roughly-square flow lattice makes most cells near-squares
  // (quads with tiny bevels), which collapse to clean quadrilaterals, while
  // genuine triangles and pentagons survive where the geometry needs them.
  const boxHalf = s * 3
  const ring = 3
  const quadDev = QUAD_DEV_FRAC * s
  const flatDev = FLAT_DEV_FRAC * s
  const cells: Pt[][] = new Array(n)
  for (let i = 0; i < n; i++) {
    const sx = jx[i]
    const sy = jy[i]
    const x0 = Math.max(0, sx - boxHalf)
    const y0 = Math.max(0, sy - boxHalf)
    const x1 = Math.min(width, sx + boxHalf)
    const y1 = Math.min(height, sy + boxHalf)
    let poly: Pt[] = [
      [x0, y0],
      [x1, y0],
      [x1, y1],
      [x0, y1],
    ]
    const gx = cellGx(cx[i])
    const gy = cellGy(cy[i])
    const si2 = sx * sx + sy * sy
    for (let dy = -ring; dy <= ring && poly.length; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        const list = hash.get(keyOf(gx + dx, gy + dy))
        if (!list) continue
        for (let li = 0; li < list.length; li++) {
          const j = list[li]
          if (j === i) continue
          const qx = jx[j]
          const qy = jy[j]
          // Bisector: keep points closer to this seed than to neighbour j.
          poly = clipHalfPlane(
            poly,
            2 * (qx - sx),
            2 * (qy - sy),
            qx * qx + qy * qy - si2
          )
          if (!poly.length) break
        }
        if (!poly.length) break
      }
    }
    // Simplify to mostly-quads (triangles … pentagons), then optionally curve.
    cells[i] =
      poly.length >= 3
        ? chaikin(simplifyCell(poly, MAX_SIDES, quadDev, flatDev), CURVE_ITERS)
        : poly
  }

  // ---- Pack the cells into the renderer's format -----------------------------
  const offsets = new Int32Array(n + 1)
  const angles = new Float32Array(n)
  const centers = new Float32Array(n * 2)
  let total = 0
  for (let i = 0; i < n; i++) total += cells[i].length
  const polys = new Float32Array(total * 2)
  let v = 0
  let extent = s
  for (let i = 0; i < n; i++) {
    offsets[i] = v
    angles[i] = ang[i]
    centers[i * 2] = jx[i]
    centers[i * 2 + 1] = jy[i]
    const cell = cells[i]
    for (let k = 0; k < cell.length; k++) {
      const px = cell[k][0]
      const py = cell[k][1]
      polys[v * 2] = px
      polys[v * 2 + 1] = py
      v++
      const d = Math.hypot(px - jx[i], py - jy[i])
      if (d > extent) extent = d
    }
  }
  offsets[n] = v
  // Cap the cull reach so one stray ballooned cell (e.g. spanning a gap) can't
  // force the overlay to scan everything.
  extent = Math.min(extent, s * 4)
  return { polys, offsets, angles, centers, count: n, tileSize: s, extent }
}
