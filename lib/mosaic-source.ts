// Where a mosaic's tiles come from.
//
// CanvasHero takes a MosaicSource so it knows nothing about storage — only how
// to load the library, build a tile URL, and identify the collection. The only
// implementation today is an ingested Roboflow dataset.

import type { CollectionCopy, LibraryItem } from "./tile-library"
import type { RoboflowDataset } from "./roboflow"
import { loadRoboflowLibrary } from "./roboflow-library"
import { releasePack, type PackProgress, type RoboflowPack } from "./roboflow-pack"

export type LibraryLoad = {
  version: string
  items: LibraryItem[]
  // Frees the tiles' object urls. Nothing in the library works afterwards.
  release: () => void
}

export type MosaicSource = {
  // Stable identity: the IndexedDB cache key for this collection's generated
  // mosaic, and the download filename fallback.
  id: string
  label: string
  copy: CollectionCopy
  loadLibrary: (options?: {
    onProgress?: (progress: PackProgress) => void
    signal?: AbortSignal
  }) => Promise<LibraryLoad>
  // Current library version, for spotting a cached mosaic built from tiles that
  // no longer exist. Null when it can't be determined.
  fetchVersion: () => Promise<string | null>
  // Tile url, once the library is loaded. Null before that, and for an id the
  // library does not contain. Returning null keeps an unavailable image from
  // accidentally reaching an <img src="">.
  thumbUrl: (id: string) => string | null
}

export function roboflowSource(dataset: RoboflowDataset): MosaicSource {
  // Held so `thumbUrl` can answer for ids the caller did not keep an item for.
  let pack: RoboflowPack | null = null

  return {
    id: `roboflow:${dataset.slug}`,
    label: dataset.name,
    copy: {
      heading: dataset.name,
      description:
        `${dataset.imageCount.toLocaleString()} images from this Roboflow ` +
        "dataset, every one of them a tile. Pick what they should reassemble " +
        "into — the project's cover image, or any image out of the dataset.",
    },
    loadLibrary: async (options = {}) => {
      const library = await loadRoboflowLibrary(dataset.slug, {
        expectedVersion: dataset.libraryVersion ?? null,
        expectedPhotoCount: dataset.imageCount,
        ...options,
      })
      pack = library.pack
      return {
        version: library.version,
        items: library.items,
        release: () => {
          if (pack === library.pack) pack = null
          releasePack(dataset.slug)
        },
      }
    },
    // The ingest stamps this into the dataset record, so no request is needed.
    fetchVersion: async () => dataset.libraryVersion ?? null,
    thumbUrl: (id) => pack?.thumbUrl(id) ?? null,
  }
}
