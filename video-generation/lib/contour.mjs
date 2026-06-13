// Contour-flow ("andamento") Voronoi tile placement, ported from the web
// engine (personal-website/lib/contour-mosaic.ts). Three stages:
//
//   1. Seeds are laid along the reference's strong edges, oriented tangent to
//      the edge (strongest contours first).
//   2. The frame fills by growing outward from those seeds in a breadth-first
//      wavefront; rows inherit their parent's flow direction and re-snap to
//      contours where one is near. A relaxation pass squares up the lattice.
//   3. Each tile's shape is the Voronoi cell of its seed, simplified toward a
//      quadrilateral (triangles/pentagons survive where geometry needs them).
//
// Output is packed polygons (`polys` + `offsets`) plus per-tile `angles` and
// `centers` — the same format the matcher/clips/renderer consume.

const CONTOUR_MAG = 0.17
const SNAP_MAG = 0.13
const MIN_DIST_FRAC = 0.74
const JITTER = 0.07
const RELAX_ITERS = 6
const RELAX_RATE = 0.5
const RELAX_MAX_DISP = 0.7
const MAX_SIDES = 5
const QUAD_DEV_FRAC = 0.26
const FLAT_DEV_FRAC = 0.07
const CURVE_ITERS = 0

function normAngle(a) {
  const pi = Math.PI
  let r = a % pi
  if (r <= -pi / 2) r += pi
  else if (r > pi / 2) r -= pi
  return r
}

function alignAngle(target, ref) {
  const pi = Math.PI
  let t = target
  while (t - ref > pi / 2) t -= pi
  while (t - ref < -pi / 2) t += pi
  return t
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function clipHalfPlane(poly, a, b, c) {
  const out = []
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

function cornerDeviation(a, b, c) {
  const ex = c[0] - a[0]
  const ey = c[1] - a[1]
  const len = Math.hypot(ex, ey)
  if (len < 1e-9) return 0
  return Math.abs((b[0] - a[0]) * ey - (b[1] - a[1]) * ex) / len
}

function shallowestCorner(p, limit) {
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

function simplifyCell(poly, maxSides, quadDev, flatDev) {
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

function chaikin(ring, iters) {
  let poly = ring
  for (let it = 0; it < iters; it++) {
    const n = poly.length
    if (n < 3) break
    const out = new Array(n * 2)
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

export function contourMosaic(width, height, tileSize, field) {
  const { mag, dir, fw, fh } = field
  const s = Math.max(2, tileSize)
  const minDist = MIN_DIST_FRAC * s
  const minDist2 = minDist * minDist
  const maxTiles = Math.ceil(width / s) * Math.ceil(height / s) * 2 + 64

  const cx = []
  const cy = []
  const ang = []

  const inv = 1 / s
  const gh = Math.ceil(height / s) + 4
  const hash = new Map()
  const keyOf = (gx, gy) => (gx + 1) * gh + (gy + 1)
  const cellGx = (x) => (x * inv) | 0
  const cellGy = (y) => (y * inv) | 0

  const fxs = fw / width
  const fys = fh / height
  const fieldIdx = (x, y) => {
    let ix = (x * fxs) | 0
    let iy = (y * fys) | 0
    if (ix < 0) ix = 0
    else if (ix >= fw) ix = fw - 1
    if (iy < 0) iy = 0
    else if (iy >= fh) iy = fh - 1
    return iy * fw + ix
  }
  const magAt = (x, y) => mag[fieldIdx(x, y)]
  const tangentAt = (x, y) => normAngle(dir[fieldIdx(x, y)] + Math.PI / 2)

  const canPlace = (x, y) => {
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

  const place = (x, y, th) => {
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

  const nearestAngle = (x, y) => {
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

  // Phase 1: lay tiles along the contours, strongest edges first.
  const seeds = []
  for (let i = 0; i < mag.length; i++) {
    if (mag[i] > CONTOUR_MAG) seeds.push(i)
  }
  seeds.sort((a, b) => mag[b] - mag[a])
  const frontier = []
  for (let si = 0; si < seeds.length && cx.length < maxTiles; si++) {
    const p = seeds[si]
    const px = p % fw
    const py = (p - px) / fw
    const x = ((px + 0.5) / fw) * width
    const y = ((py + 0.5) / fh) * height
    if (!canPlace(x, y)) continue
    frontier.push(place(x, y, tangentAt(x, y)))
  }

  // Phase 2: breadth-first growth outward from the contour seeds.
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

  // Phase 3: staggered sweep for any holes the wavefront left behind.
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

  // Relax seeds toward a locally-square lattice so corners come out near 90°.
  if (RELAX_ITERS > 0) {
    const homeX = cx.slice()
    const homeY = cy.slice()
    const relaxCap = RELAX_MAX_DISP * s
    const rr = 2
    const tcx = new Array(cx.length)
    const tcy = new Array(cx.length)
    for (let it = 0; it < RELAX_ITERS; it++) {
      for (let i = 0; i < cx.length; i++) {
        const xi = cx[i]
        const yi = cy[i]
        const th = ang[i]
        const ux = Math.cos(th)
        const uy = Math.sin(th)
        const vx = -uy
        const vy = ux
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

  // Deterministic jitter so flat regions vary into organic quads.
  const n = cx.length
  const jx = new Float32Array(n)
  const jy = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const rng = mulberry32((Math.imul(i + 1, 2654435761) ^ 0x9e3779b9) >>> 0)
    jx[i] = Math.min(width, Math.max(0, cx[i] + (rng() * 2 - 1) * JITTER * s))
    jy[i] = Math.min(height, Math.max(0, cy[i] + (rng() * 2 - 1) * JITTER * s))
  }

  // Voronoi cell per seed (Sutherland–Hodgman against neighbour bisectors),
  // simplified toward a quad.
  const boxHalf = s * 3
  const ring = 3
  const quadDev = QUAD_DEV_FRAC * s
  const flatDev = FLAT_DEV_FRAC * s
  const cells = new Array(n)
  for (let i = 0; i < n; i++) {
    const sx = jx[i]
    const sy = jy[i]
    const x0 = Math.max(0, sx - boxHalf)
    const y0 = Math.max(0, sy - boxHalf)
    const x1 = Math.min(width, sx + boxHalf)
    const y1 = Math.min(height, sy + boxHalf)
    let poly = [
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
    cells[i] =
      poly.length >= 3
        ? chaikin(simplifyCell(poly, MAX_SIDES, quadDev, flatDev), CURVE_ITERS)
        : poly
  }

  // Pack into the renderer's format.
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
  extent = Math.min(extent, s * 4)
  return { polys, offsets, angles, centers, count: n, tileSize: s, extent }
}

// Per-cell axis-aligned bounds (x, y, w, h × count) of the packed polygons —
// used for zoom-window culling and clip sizing.
export function cellBBoxes(polys, offsets, count) {
  const bboxes = new Float32Array(count * 4)
  for (let i = 0; i < count; i++) {
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let v = offsets[i]; v < offsets[i + 1]; v++) {
      const x = polys[v * 2]
      const y = polys[v * 2 + 1]
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
    if (!Number.isFinite(minX)) {
      minX = 0
      minY = 0
      maxX = 0
      maxY = 0
    }
    bboxes[i * 4] = minX
    bboxes[i * 4 + 1] = minY
    bboxes[i * 4 + 2] = maxX - minX
    bboxes[i * 4 + 3] = maxY - minY
  }
  return bboxes
}

// Typed arrays are stored base64 so plan.json stays one self-contained file.
export function encodeTypedArray(arr) {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString(
    "base64"
  )
}

function decodeTypedArray(encoded, Ctor) {
  const buf = Buffer.from(encoded, "base64")
  const out = new Uint8Array(buf.byteLength)
  out.set(buf)
  return new Ctor(out.buffer)
}

export function encodeGeometry(geometry) {
  return {
    count: geometry.count,
    tileSize: geometry.tileSize,
    extent: geometry.extent,
    polys: encodeTypedArray(geometry.polys),
    offsets: encodeTypedArray(geometry.offsets),
    angles: encodeTypedArray(geometry.angles),
    centers: encodeTypedArray(geometry.centers),
    bboxes: encodeTypedArray(geometry.bboxes),
  }
}

export function decodeGeometry(encoded) {
  return {
    count: encoded.count,
    tileSize: encoded.tileSize,
    extent: encoded.extent,
    polys: decodeTypedArray(encoded.polys, Float32Array),
    offsets: decodeTypedArray(encoded.offsets, Int32Array),
    angles: decodeTypedArray(encoded.angles, Float32Array),
    centers: decodeTypedArray(encoded.centers, Float32Array),
    bboxes: decodeTypedArray(encoded.bboxes, Float32Array),
  }
}
