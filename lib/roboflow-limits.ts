export const MIB = 1024 * 1024

// Leave 30 seconds for final status persistence and scratch cleanup before the
// route's five-minute maxDuration is reached.
export const VERCEL_INGEST_DEADLINE_MS = 270_000
export const MAX_EXPORT_WAIT_MS = 90_000
