// Browser-side loader for an ingested Roboflow dataset's tile library.
//
// Everything comes out of the one archive the pack module downloads — the
// manifest, the concatenated coarse signatures, and the thumbnails, which are
// object urls by the time they reach a LibraryItem rather than routes to fetch.

import { COARSE_SIG_BYTES, type LibraryItem } from "./tile-library"
import {
  acquirePack,
  type PackProgress,
  type RoboflowPack,
} from "./roboflow-pack"

export type RoboflowLibrary = {
  version: string
  items: LibraryItem[]
  // Held so the caller can revoke every object url when it is done with the
  // dataset; the items' urls die with it.
  pack: RoboflowPack
}

export type { PackProgress }

export async function loadRoboflowLibrary(
  slug: string,
  options: {
    expectedVersion?: string | null
    expectedPhotoCount?: number | null
    onProgress?: (progress: PackProgress) => void
    signal?: AbortSignal
  } = {}
): Promise<RoboflowLibrary> {
  const pack = await acquirePack(slug, options)
  const photos = pack.manifest.photos ?? []
  if (!photos.length) throw new Error("This dataset ingested zero usable images.")

  const needed = photos.length * COARSE_SIG_BYTES
  if (pack.signatures.length < needed) {
    throw new Error(
      `Signature blob is short: ${pack.signatures.length} < ${needed}. Re-ingest the dataset.`
    )
  }

  const items: LibraryItem[] = []
  for (let i = 0; i < photos.length; i++) {
    const { id, w, h } = photos[i]
    const url = pack.thumbUrl(id)
    // A manifest entry whose thumbnail did not make it into the archive would
    // otherwise become a tile the worker can never paint.
    if (!url) continue
    const base = i * COARSE_SIG_BYTES
    items.push({
      id,
      sig: pack.signatures.subarray(base, base + COARSE_SIG_BYTES),
      w,
      h,
      url,
    })
  }
  if (!items.length) {
    throw new Error("The dataset archive contained no usable thumbnails.")
  }

  return { version: pack.version, items, pack }
}
