// Message contract between the main thread (lib/mosaic-client.ts) and the mosaic
// Web Worker (lib/mosaic-worker.ts). Kept type-only so it can be imported from
// both sides without creating a runtime dependency cycle.

import type { Grid } from "./mosaic"

// A tile from the shared library, replayed into the worker's in-memory store so
// it can participate in matching/rendering. The thumbnail isn't sent inline —
// the worker fetches it lazily from `url` only when the tile is actually placed.
export type HydrateItem = {
  id: string
  sig: Uint8Array
  w: number
  h: number
  url: string
}

export type WorkerRequest =
  | { type: "hydrate"; items: HydrateItem[] }
  | {
      type: "generate"
      reqId: number
      cellSigs: Float32Array[]
      grid: Grid
      ids: string[]
      // Size of the mosaic frame the polygons live in; the worker renders its
      // OffscreenCanvas at exactly this resolution so nothing is clipped.
      width: number
      height: number
      // Per-cell edge orientation (radians) so the worker can rotate each tile's
      // photo along the reference's contours.
      angles: Float32Array
      // Voronoi cell polygons (computed on the main thread): all vertices in
      // `polys` as x,y pairs, with cell `i` spanning `offsets[i]..offsets[i+1]`.
      polys: Float32Array
      offsets: Int32Array
      // Optional per-generated-mosaic cap. When set, a single source photo will
      // not be assigned more than this many cells unless the library is too small.
      maxTileReuse?: number
    }

export type WorkerResponse =
  | {
      type: "progress"
      reqId: number
      done: number
      total: number
    }
  // An in-progress snapshot of the mosaic as it fills in (cells matched so far),
  // emitted periodically during generate so the UI can show live progress.
  | {
      type: "progressFrame"
      reqId: number
      base: ImageBitmap
      done: number
      total: number
    }
  | {
      type: "generated"
      reqId: number
      assignment: Int32Array
      base: ImageBitmap
    }
