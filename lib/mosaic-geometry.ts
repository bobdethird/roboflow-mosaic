// Per-tile geometry for live zoom-to-reveal. Each cell is a center (x,y), an
// angle, and an index into a compacted tile list (url + thumbnail + title). At
// zoom the overlay paints each photo into a `tileSize`-sided square at its
// center/angle over the composite so edges line up and max zoom shows one real
// photo. Built in memory for the live generator — not serialized for publish.

import type { GalleryTile } from "./gallery"

// Decoded, ready-to-render geometry the zoom viewer consumes.
export type MosaicGeometry = {
  frameW: number
  frameH: number
  // Mosaic cell size in frame px; the on-screen tile side is tileSize·displayScale·zoom.
  tileSize: number
  count: number
  // Per-cell, parallel arrays (length `count`).
  cx: Float32Array
  cy: Float32Array
  ang: Float32Array
  // Index into `tiles`, or -1 for an unassigned cell.
  t: Int32Array
  // Compacted source photos referenced by `t`.
  tiles: GalleryTile[]
}

// ─── build ───────────────────────────────────────────────────────────────────

// Reduce a generated mosaic's per-cell data to in-memory geometry. `assignment`
// indexes into `tileIds`; `resolveTile` turns an id into its GalleryTile.
export function buildMosaicGeometry(opts: {
  frameW: number
  frameH: number
  tileSize: number
  centers: Float32Array
  angles: Float32Array
  assignment: Int32Array
  tileIds: string[]
  resolveTile: (id: string) => GalleryTile
}): MosaicGeometry {
  const { frameW, frameH, tileSize, centers, angles, assignment, tileIds } =
    opts
  const count = Math.min(centers.length / 2, angles.length, assignment.length)
  const cx = new Float32Array(count)
  const cy = new Float32Array(count)
  const ang = new Float32Array(count)
  const t = new Int32Array(count)

  const compact = new Map<number, number>()
  const tiles: GalleryTile[] = []
  for (let i = 0; i < count; i++) {
    cx[i] = centers[i * 2]
    cy[i] = centers[i * 2 + 1]
    ang[i] = angles[i]
    const a = assignment[i]
    if (a < 0 || a >= tileIds.length) {
      t[i] = -1
      continue
    }
    let ci = compact.get(a)
    if (ci === undefined) {
      tiles.push(opts.resolveTile(tileIds[a]))
      ci = tiles.length - 1
      compact.set(a, ci)
    }
    t[i] = ci
  }

  return { frameW, frameH, tileSize, count, cx, cy, ang, t, tiles }
}

// ─── client-side tile image cache ─────────────────────────────────────────────
// The overlay needs decoded images for only the handful of tiles on screen, and
// must not stampede the network when panning. This caches loaded images by url
// (LRU) and limits concurrent loads; `request` dedupes and notifies via onLoad so
// the viewer can repaint when a tile arrives.
export class TileImageCache {
  private ready = new Map<string, HTMLImageElement>()
  private inflight = new Map<string, Promise<void>>()
  private order: string[] = []
  private active = 0
  private waiting: string[] = []
  // Currently on-screen urls. Eviction never drops these, so a tile that's
  // visible can't be evicted and reloaded mid-zoom — which is what caused the
  // overlay to flicker when paused at a partial zoom (hundreds of tiles visible,
  // more than the cap, thrashing the cache).
  private pinned: Set<string> = new Set()
  private readonly max: number
  private readonly concurrency: number
  // Called (deduped by the caller) whenever a new image finishes loading.
  onLoad: (() => void) | null = null

  constructor(opts?: { max?: number; concurrency?: number }) {
    this.max = opts?.max ?? 1024
    this.concurrency = opts?.concurrency ?? 12
  }

  // Declare the set of urls currently on screen so eviction spares them.
  pin(urls: Set<string>): void {
    this.pinned = urls
  }

  // A decoded image if it's already loaded (marks it most-recently-used), else null.
  get(url: string): HTMLImageElement | null {
    const img = this.ready.get(url)
    if (img) this.touch(url)
    return img ?? null
  }

  // Ensure `url` is loading or loaded. Safe to call every frame.
  request(url: string): void {
    if (this.ready.has(url) || this.inflight.has(url)) return
    if (this.active >= this.concurrency) {
      if (!this.waiting.includes(url)) this.waiting.push(url)
      return
    }
    this.start(url)
  }

  private start(url: string): void {
    this.active++
    const promise = new Promise<void>((resolve) => {
      const img = new Image()
      img.decoding = "async"
      const done = (ok: boolean) => {
        this.inflight.delete(url)
        this.active--
        if (ok) {
          this.ready.set(url, img)
          this.touch(url)
          this.evict()
          this.onLoad?.()
        }
        this.pump()
        resolve()
      }
      img.onload = () => done(true)
      img.onerror = () => done(false)
      img.src = url
    })
    this.inflight.set(url, promise)
  }

  private pump(): void {
    while (this.active < this.concurrency && this.waiting.length > 0) {
      const url = this.waiting.shift()!
      if (this.ready.has(url) || this.inflight.has(url)) continue
      this.start(url)
    }
  }

  private touch(url: string): void {
    const i = this.order.indexOf(url)
    if (i >= 0) this.order.splice(i, 1)
    this.order.push(url)
  }

  private evict(): void {
    let removable = this.order.length - this.max
    if (removable <= 0) return
    // Drop the oldest UNpinned entries first; never evict an on-screen tile (so
    // it can't vanish and reload). If everything left is pinned the cache simply
    // grows past `max` for that frame — bounded by the visible set.
    const next: string[] = []
    for (const url of this.order) {
      if (removable > 0 && !this.pinned.has(url)) {
        this.ready.delete(url)
        removable--
      } else {
        next.push(url)
      }
    }
    this.order = next
  }
}
