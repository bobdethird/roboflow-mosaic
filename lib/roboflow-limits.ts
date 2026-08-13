export const MIB = 1024 * 1024

// Keep headroom below Vercel's 500 MB /tmp ceiling for Sharp's temporary work,
// status files, and a few in-flight thumbnails.
export const MAX_VERCEL_EXPORT_BYTES = 320 * MIB
export const MAX_VERCEL_LIBRARY_BYTES = 128 * MIB
export const MAX_VERCEL_IMAGES = 5_000

// The browser incrementally unpacks the streamed ZIP, but still retains every
// thumbnail as an object URL and one Blob for IndexedDB. Match the server's
// generated-library ceiling so an unexpected archive cannot consume unbounded
// client memory.
export const MAX_PACK_BYTES = MAX_VERCEL_LIBRARY_BYTES
export const MAX_EXPANDED_PACK_BYTES = MAX_PACK_BYTES + 8 * MIB

// Leave 30 seconds for final status persistence and scratch cleanup before the
// route's five-minute maxDuration is reached.
export const VERCEL_INGEST_DEADLINE_MS = 270_000
export const MAX_EXPORT_WAIT_MS = 90_000

export function storageLimitMessage(
  kind: "export" | "library",
  maxBytes: number
): string {
  const limit = Math.floor(maxBytes / MIB)
  return `This dataset's ${kind} is too large for this deployment (limit: ${limit} MB). Try a smaller dataset.`
}

export function imageLimitMessage(maxImages: number): string {
  return `This dataset has too many images for this deployment (limit: ${maxImages.toLocaleString()}). Try a smaller dataset.`
}
