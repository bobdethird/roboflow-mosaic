// Browser-side loader for an ingested Roboflow dataset's tile library.
//
// Reads `manifest.json` plus the concatenated coarse-signature blob from the
// local asset route. Thumbnails are still fetched lazily by the worker, one per
// placed tile.

import { COARSE_SIG_BYTES, type LibraryItem } from "./tile-library"
import {
  COARSE_SIGNATURES_FILE,
  MANIFEST_FILE,
  readJsonBody,
  roboflowAssetUrl,
  roboflowThumbPath,
} from "./roboflow"

export type RoboflowManifest = {
  version: string
  photos: { id: string; w: number; h: number; file?: string }[]
}

export type RoboflowLibrary = {
  version: string
  items: LibraryItem[]
}

// The manifest alone — the id list the reference picker browses.
export async function loadRoboflowManifest(
  slug: string
): Promise<RoboflowManifest> {
  const response = await fetch(roboflowAssetUrl(slug, MANIFEST_FILE))
  if (!response.ok) {
    throw new Error(`Could not load the dataset manifest (${response.status}).`)
  }
  return await readJsonBody<RoboflowManifest>(response)
}

// Just the library version, without pulling the signatures blob — used to spot a
// cached mosaic whose tiles came from an earlier ingest.
export async function roboflowLibraryVersion(
  slug: string
): Promise<string | null> {
  try {
    const response = await fetch(roboflowAssetUrl(slug, MANIFEST_FILE))
    if (!response.ok) return null
    return (await readJsonBody<RoboflowManifest>(response)).version ?? null
  } catch {
    return null
  }
}

export async function loadRoboflowLibrary(
  slug: string
): Promise<RoboflowLibrary> {
  const manifestResponse = await fetch(roboflowAssetUrl(slug, MANIFEST_FILE))
  if (!manifestResponse.ok) {
    throw new Error(`Could not load the dataset manifest (${manifestResponse.status}).`)
  }
  const manifest = await readJsonBody<RoboflowManifest>(manifestResponse)
  const count = manifest.photos?.length ?? 0
  if (!count) throw new Error("This dataset ingested zero usable images.")

  const signaturesResponse = await fetch(
    roboflowAssetUrl(slug, COARSE_SIGNATURES_FILE)
  )
  if (!signaturesResponse.ok) {
    throw new Error(`Could not load tile signatures (${signaturesResponse.status}).`)
  }
  const bytes = new Uint8Array(await signaturesResponse.arrayBuffer())
  if (bytes.length < count * COARSE_SIG_BYTES) {
    throw new Error(
      `Signature blob is short: ${bytes.length} < ${count * COARSE_SIG_BYTES}. Re-ingest the dataset.`
    )
  }

  const items: LibraryItem[] = new Array(count)
  for (let i = 0; i < count; i++) {
    const { id, w, h } = manifest.photos[i]
    const base = i * COARSE_SIG_BYTES
    const url = roboflowAssetUrl(slug, roboflowThumbPath(id))
    items[i] = {
      id,
      sig: bytes.subarray(base, base + COARSE_SIG_BYTES),
      w,
      h,
      url,
    }
  }
  return { version: manifest.version, items }
}
