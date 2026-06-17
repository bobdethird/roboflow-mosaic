// Shared shapes for the pre-baked landing-page mosaic gallery. The dev-only
// /bake tooling writes these static artifacts into public/gallery, and the
// MosaicGallery component reads them at runtime.

// One entry per baked mosaic, listed in public/gallery/index.json.
export type GalleryIndexEntry = {
  name: string
  // Public path to the baked mosaic image.
  src: string
  // Saved image pixel dimensions (for masonry aspect ratio).
  w: number
  h: number
  alt: string
}

// A single source frame revealed in the hover popup. `url` is the click-through
// source frame; `previewUrl` can point at a smaller thumbnail for hover rendering.
export type GalleryTile = { url: string; title: string; previewUrl?: string }

// Per-mosaic hover hit-map (public/gallery/<name>.json). The frame is divided
// into a cols×rows grid; each bucket stores the index (into `tiles`) of the
// source frame nearest that spot, or -1 when empty. Resolution-independent: the
// gallery maps a normalized pointer position straight onto the grid.
export type GalleryTileMap = {
  w: number
  h: number
  cols: number
  rows: number
  grid: number[]
  tiles: GalleryTile[]
}

export const GALLERY_INDEX_URL = "/gallery/index.json"

// The hover hit-map sits beside each baked image (foo.jpg → foo.json).
export function tileMapUrlFor(src: string): string {
  return src.replace(/\.jpg$/i, ".json")
}
