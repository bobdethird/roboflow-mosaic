export const NEW_YORK_MOSAIC_FORM_URL =
  "https://forms.gle/kBDYoNE2Bpr8cdLp9"

export const NEW_YORK_MOSAIC_ANALYTICS_EVENT =
  "New York Mosaic Form Opened"

export const NEW_YORK_MOSAIC_UPLOAD_OPENED_EVENT =
  "New York Mosaic Upload Opened"

export const NEW_YORK_MOSAIC_UPLOAD_SUBMITTED_EVENT =
  "New York Mosaic Upload Submitted"

// Endpoint the in-page upload flow posts to.
export const NEW_YORK_MOSAIC_UPLOAD_ENDPOINT = "/api/newyork-submissions"

// Keep these in sync with the server limits in lib/new-york-submissions-store.ts
// (they're only used for client-side UX — the server re-validates everything).
export const NEW_YORK_MOSAIC_MAX_FILES = 5
export const NEW_YORK_MOSAIC_MAX_IMAGE_BYTES = 10 * 1024 * 1024

export const NEW_YORK_MOSAIC_LEGACY_PATH = "/newyork-mosaic"

export type NewYorkMosaicFormSource =
  | "home-intro"
  | "mosaic-page"
  | "canvas-mobile"
  | "canvas-sidebar"
