// Shared shape of a mosaic tile library: on-the-wire signature sizes the worker
// decodes, and the hydrated tile the engine matches against.

import { SIGNATURE_GRID } from "./mosaic"

// Bytes per full signature: SIGNATURE_GRID² cells × 3 channels, one uint8 each.
export const SIG_BYTES = SIGNATURE_GRID * SIGNATURE_GRID * 3

const COARSE_SIGNATURE_GRID = Math.max(1, SIGNATURE_GRID >> 1)
const COARSE_SIG_VALUES = COARSE_SIGNATURE_GRID * COARSE_SIGNATURE_GRID * 3
// The worker compares on 8x8 signatures derived by averaging 2x2 blocks of the
// full uint8 signature, each stored as the exact 0..1020 sum (value * 4).
export const COARSE_SIG_BYTES = COARSE_SIG_VALUES * 2

// Heading + blurb shown beside the mosaic for a collection.
export type CollectionCopy = { heading: string; description: string }

// A library tile, ready to hydrate into the mosaic worker. The thumbnail is not
  // sent inline: `url` is an asset URL for the tile's thumbnail, and the worker
  // reads it only when the tile is actually placed.
export type LibraryItem = {
  id: string
  sig: Uint8Array
  w: number
  h: number
  url: string
}
