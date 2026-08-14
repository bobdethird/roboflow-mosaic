// Shared sampling: which images become tiles.
//
// Used by the Roboflow API ingest and the local-directory ingest. Nothing here
// does I/O — the caller already has the candidate list.

import {
  TILE_BUDGET,
  TILE_DECODE_MS,
  TILE_FETCH_BYTES_PER_MS,
} from "./roboflow-limits"

export const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".bmp",
  ".tif",
  ".tiff",
  ".avif",
])

export function isImageEntryName(name: string): boolean {
  const dot = name.lastIndexOf(".")
  if (dot < 0) return false
  return IMAGE_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

// Keeps at most `cap` items, spread evenly across an unknown-length sequence:
// once full it drops every other item it kept and doubles its stride, so the
// survivors stay evenly spaced no matter how much more arrives.
export class EvenSample<T> {
  private kept: T[] = []
  private seen = 0
  private step = 1

  constructor(private readonly cap: number) {
    if (cap < 1) throw new Error("Sample cap must be at least one.")
  }

  push(item: T): void {
    const index = this.seen++
    if (index % this.step !== 0) return
    this.kept.push(item)
    if (this.kept.length <= this.cap) return
    let write = 0
    for (let read = 0; read < this.kept.length; read += 2) {
      this.kept[write++] = this.kept[read]
    }
    this.kept.length = write
    this.step *= 2
  }

  get items(): T[] {
    return this.kept
  }

  get total(): number {
    return this.seen
  }

  get stride(): number {
    return this.step
  }
}

export type SampledEntry = { compressedSize: number }

export type SampledIndex<T extends SampledEntry> = { entries: T[] }

// How many tiles this run can afford, and which entries they come from.
//
// A dataset with more images than the tile budget is sampled across the whole
// set rather than cut off partway, so the mosaic still draws from all of it.
export function planTileSample<T extends SampledEntry>(
  index: SampledIndex<T>,
  options: { budget?: number; msAvailable?: number; msPerItem?: number } = {}
): T[] {
  const entries = index.entries
  if (!entries.length) return []

  let count = Math.min(entries.length, options.budget ?? TILE_BUDGET)
  if (options.msAvailable !== undefined) {
    const msPerTile =
      options.msPerItem ??
      (() => {
        let bytes = 0
        for (const entry of entries) bytes += entry.compressedSize
        const averageBytes = bytes / entries.length
        return averageBytes / TILE_FETCH_BYTES_PER_MS + TILE_DECODE_MS
      })()
    const affordable = Math.floor(Math.max(0, options.msAvailable) / msPerTile)
    count = Math.max(1, Math.min(count, affordable))
  }
  if (count >= entries.length) return entries

  const sampled: T[] = new Array(count)
  for (let i = 0; i < count; i++) {
    sampled[i] = entries[Math.floor((i * entries.length) / count)]
  }
  return sampled
}

// Which global indices to keep when sampling `take` items out of `total`
// without holding the whole list. Matches `planTileSample`'s stride.
export function evenSampleIndices(total: number, take: number): Set<number> {
  const wanted = new Set<number>()
  if (total <= 0 || take <= 0) return wanted
  const count = Math.min(total, take)
  if (count >= total) {
    for (let index = 0; index < total; index++) wanted.add(index)
    return wanted
  }
  for (let i = 0; i < count; i++) {
    wanted.add(Math.floor((i * total) / count))
  }
  return wanted
}
