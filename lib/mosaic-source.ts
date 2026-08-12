// Where a mosaic's tiles come from.
//
// CanvasHero used to take a Supabase bucket name and load that collection
// directly. It takes one of these instead, so the component knows nothing about
// where a library lives — only how to load it, how to build a tile's URL, and
// whether the result can be published. Today the one implementation is an
// ingested Roboflow dataset; the indirection is what let the inherited UI be
// reused without forking it.

import type { CollectionCopy, LibraryItem } from "./tile-library"
import { roboflowAssetUrl, roboflowThumbPath, type RoboflowDataset } from "./roboflow"
import { loadRoboflowLibrary, roboflowLibraryVersion } from "./roboflow-library"

export type MosaicSource = {
  // Stable identity: the IndexedDB cache key for this collection's generated
  // mosaic, and the download filename fallback.
  id: string
  label: string
  copy: CollectionCopy
  // Whether the mosaic can be published to a shareable link, and whether the
  // host site's own chrome (its cross-links) belongs on the page. False for a
  // Roboflow dataset: its tiles live in this app's local ingest cache, so a
  // share link would have nothing to resolve them against.
  shareable: boolean
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
    shareable: false,
    loadLibrary: () => loadRoboflowLibrary(dataset.slug),
    fetchVersion: () => roboflowLibraryVersion(dataset.slug),
    thumbUrl: (id) => roboflowAssetUrl(dataset.slug, roboflowThumbPath(id)),
  }
}
