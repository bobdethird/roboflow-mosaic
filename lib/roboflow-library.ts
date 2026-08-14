// Browser-side loader for an ingested Roboflow dataset's tile library.
//
// The pack module downloads the advertised snapshot — the manifest and the
// concatenated coarse signatures. Thumbnails stay as asset URLs and are
// fetched only when something actually draws them.

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
    hasIcon?: boolean
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
    // A manifest entry whose thumbnail was never published would otherwise
    // become a tile the worker can never paint.
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
    throw new Error("The dataset snapshot contained no usable thumbnails.")
  }

  return { version: pack.version, items, pack }
}
