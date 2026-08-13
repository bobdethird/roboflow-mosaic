// Where a mosaic's tiles come from.
//
// CanvasHero takes a MosaicSource so it knows nothing about storage — only how
// to load the library, build a tile URL, and identify the collection. The only
// implementation today is an ingested Roboflow dataset.

import type { CollectionCopy, LibraryItem } from "./tile-library"
import { roboflowAssetUrl, roboflowThumbPath, type RoboflowDataset } from "./roboflow"
import { loadRoboflowLibrary, roboflowLibraryVersion } from "./roboflow-library"

export type MosaicSource = {
  // Stable identity: the IndexedDB cache key for this collection's generated
  // mosaic, and the download filename fallback.
  id: string
  label: string
  copy: CollectionCopy
  loadLibrary: () => Promise<{ version: string; items: LibraryItem[] }>
  // Current library version, for spotting a cached mosaic built from tiles that
  // no longer exist. Null when it can't be determined.
  fetchVersion: () => Promise<string | null>
  thumbUrl: (id: string) => string
}

export function roboflowSource(dataset: RoboflowDataset): MosaicSource {
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
    loadLibrary: () => loadRoboflowLibrary(dataset.slug),
    fetchVersion: () => roboflowLibraryVersion(dataset.slug),
    thumbUrl: (id) => roboflowAssetUrl(dataset.slug, roboflowThumbPath(id)),
  }
}
