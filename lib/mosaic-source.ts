// Where a mosaic's tiles come from.
//
// CanvasHero used to take a Supabase bucket name and call into
// `lib/photo-library.ts` directly. It now takes one of these instead, so the
// same UI can be driven by a Supabase collection or by a locally-ingested
// Roboflow dataset — the two differ only in how the library loads, how a tile's
// URL is built, and whether the result can be published.

import type { BucketCopy, LibraryItem, MosaicBucket } from "./photo-library"
import {
  BUCKET_COPY,
  BUCKET_LABELS,
  fetchLibraryVersion,
  loadLibrary,
  thumbUrl,
} from "./photo-library"
import type { RoboflowDataset } from "./roboflow"
import { roboflowAssetUrl, roboflowThumbPath } from "./roboflow"
import {
  loadRoboflowLibrary,
  roboflowLibraryVersion,
} from "./roboflow-library"

export type MosaicSource = {
  // Stable identity: the IndexedDB cache key for this collection's generated
  // mosaic, the download filename fallback, and the analytics/share label.
  id: string
  label: string
  copy: BucketCopy
  // Whether the mosaic can be published to a /m/<id> link. Only the Supabase
  // collections can — the share route stores against a known bucket.
  shareable: boolean
  loadLibrary: () => Promise<{ version: string; items: LibraryItem[] }>
  // Current library version, for spotting a cached mosaic built from tiles that
  // no longer exist. Null when it can't be determined.
  fetchVersion: () => Promise<string | null>
  thumbUrl: (id: string) => string
}

export function supabaseSource(bucket: MosaicBucket): MosaicSource {
  return {
    id: bucket,
    label: BUCKET_LABELS[bucket],
    copy: BUCKET_COPY[bucket],
    shareable: true,
    loadLibrary: () => loadLibrary(bucket),
    fetchVersion: () => fetchLibraryVersion(bucket),
    thumbUrl: (id) => thumbUrl(bucket, id),
  }
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
    // A Roboflow library lives in this app's local cache, not in Supabase, so
    // the share route has nothing to resolve its tiles against.
    shareable: false,
    loadLibrary: () => loadRoboflowLibrary(dataset.slug),
    fetchVersion: () => roboflowLibraryVersion(dataset.slug),
    thumbUrl: (id) => roboflowAssetUrl(dataset.slug, roboflowThumbPath(id)),
  }
}
