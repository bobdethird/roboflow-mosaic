// Where a built tile library goes.
//
// Thumbnails are written as individual files as soon as they are seeded, so a
// mosaic can fetch a tile the moment its snapshot advertises it. Manifest and
// signature blobs are published separately as immutable, revision-addressed
// snapshots (lib/roboflow-blob.ts `publishLibrarySnapshot`) so a poll never
// observes a mismatched pair.
//
//   • `directorySink` writes into the local cache directory.
//   • `blobFileSink` PUTs each file to Blob under its own key.

import { mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"

import { put } from "@vercel/blob"

import { ICON_FILE } from "./roboflow"
import {
  PUBLISHED_FILE,
  STORE_MAX_AGE,
  blobKey,
} from "./roboflow-blob"

export type LibrarySink = {
  // Add one file to the library under `name`, a path inside the dataset.
  add: (name: string, bytes: Buffer) => Promise<void>
  // Close the library out. Thumbnails are already readable; this records that
  // the ingest finished writing files.
  finish: () => Promise<void>
  // Give up without advertising a new snapshot. Already-written thumbnails are
  // harmless — they are not referenced until a snapshot names them.
  abort: () => Promise<void>
}

// ─── Local cache directory ───────────────────────────────────────────────────

export async function directorySink(directory: string): Promise<LibrarySink> {
  await mkdir(directory, { recursive: true })
  // A re-ingest can produce fewer thumbnails than the last one did, and the
  // asset route serves whatever is in the directory, so stale files would
  // otherwise ride along in every later load.
  await rm(path.join(directory, "thumbs"), { recursive: true, force: true })
  await rm(path.join(directory, "snapshots"), { recursive: true, force: true })
  await mkdir(path.join(directory, "thumbs"), { recursive: true })

  return {
    add: async (name, bytes) => {
      const target = path.join(directory, name)
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, bytes)
    },
    finish: async () => {},
    abort: async () => {},
  }
}

// ─── Individual Blob files ───────────────────────────────────────────────────

export async function blobFileSink(
  slug: string,
  options: { abortSignal?: AbortSignal } = {}
): Promise<LibrarySink> {
  const { abortSignal } = options
  const names = new Set<string>()

  return {
    add: async (name, bytes) => {
      if (names.has(name)) return
      names.add(name)
      await put(blobKey(slug, name), bytes, {
        access: "public",
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: name.endsWith(".jpg")
          ? "image/jpeg"
          : name.endsWith(".json")
            ? "application/json"
            : "application/octet-stream",
        cacheControlMaxAge: STORE_MAX_AGE,
        abortSignal,
      })
    },
    finish: async () => {
      await put(
        blobKey(slug, PUBLISHED_FILE),
        JSON.stringify({ hasIcon: names.has(ICON_FILE) }),
        {
          access: "public",
          addRandomSuffix: false,
          allowOverwrite: true,
          contentType: "application/json",
          cacheControlMaxAge: STORE_MAX_AGE,
          abortSignal,
        }
      )
    },
    abort: async () => {},
  }
}
