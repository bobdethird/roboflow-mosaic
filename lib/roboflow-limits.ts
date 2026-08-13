export const MIB = 1024 * 1024

// Leave 30 seconds for final status persistence before the route's five-minute
// maxDuration is reached.
export const VERCEL_INGEST_DEADLINE_MS = 270_000
export const MAX_EXPORT_WAIT_MS = 90_000

// Time held back from the deadline so the library that has been built can always
// be finished and published: the last multipart part, the manifest, the status
// write. Everything before this point is interruptible; this part is not.
export const PUBLISH_RESERVE_MS = 40_000

// Tiles a library is built from, at most.
//
// This is not a storage limit — nothing is staged on disk any more — it is what
// the mosaic can actually use. The frame is 1600px on its long edge and the
// finest cell size the UI offers is 8px, so a mosaic has at most ~30,000 cells
// and the default presets use ~7,500; past that, extra tiles are bytes the
// browser downloads and holds to draw nothing. A dataset with more images than
// this is sampled evenly across the whole set (see `planTileSample`) rather than
// truncated, so the tiles still come from all of it.
export const TILE_BUDGET = 20_000

// Image entries the export index keeps before it starts thinning them evenly.
// Four times the budget leaves the sample room to be spread across the dataset
// while keeping the index itself small for a million-image export.
export const MAX_INDEXED_IMAGES = 4 * TILE_BUDGET

// Below this many tiles a mosaic is not worth showing, so an ingest that runs out
// of time with fewer than this fails instead of publishing a stub.
export const MIN_PARTIAL_TILES = 32

// Rough per-image cost used to decide how many tiles a deployment can build
// before its deadline: bytes off the export host, plus the decode and re-encode.
// Both are aggregates across the ingest's concurrency, and both are only used to
// pick a sample size — an estimate that turns out optimistic just means the
// ingest stops early with the tiles it has.
export const TILE_FETCH_BYTES_PER_MS = 40_000
export const TILE_DECODE_MS = 3
