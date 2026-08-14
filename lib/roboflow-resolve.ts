// Resolve a Roboflow URL to a concrete dataset version. Kept free of Sharp and
// Blob so the browser-facing catalog routes stay a thin JSON proxy.

import {
  datasetSlug,
  universeUrl,
  type RoboflowRef,
} from "./roboflow"
import { fetchProjectInfo } from "./roboflow-api"

export class IngestError extends Error {}

export type ResolvedDataset = {
  ref: RoboflowRef & { version: number }
  name: string
  type?: string
  images: number
  iconUrl?: string
}

export async function resolveDataset(
  ref: RoboflowRef,
  options: { apiKey?: string; signal?: AbortSignal } = {}
): Promise<ResolvedDataset> {
  const info = await fetchProjectInfo(ref, options)
  const version = ref.version ?? info.latestVersion
  if (version === null) {
    throw new IngestError(
      `${info.name} has no generated dataset versions yet — open it on Roboflow ` +
        "Universe and pick a version, then paste that URL."
    )
  }
  if (ref.version !== null && !info.versions.includes(version)) {
    throw new IngestError(
      `Version ${version} does not exist. Available versions: ${info.versions.join(", ") || "none"}.`
    )
  }
  // Roboflow keeps versions whose generation never produced anything; they
  // report zero images. Reaching one means it was asked for by name, or that
  // the project has no other kind — either way, saying so beats failing later.
  if (info.imagesByVersion.get(version) === 0) {
    const usable = info.versions.filter(
      (n) => info.imagesByVersion.get(n) !== 0
    )
    throw new IngestError(
      usable.length
        ? `Version ${version} of ${info.name} contains no images. Versions with images: ${usable.join(", ")}.`
        : `${info.name} has no version containing images yet.`
    )
  }
  return {
    ref: { ...ref, version },
    name: info.name,
    type: info.type,
    images: info.imagesByVersion.get(version) ?? 0,
    iconUrl: info.iconUrl,
  }
}

export function resolvedRecord(resolved: ResolvedDataset) {
  return {
    ...resolved.ref,
    slug: datasetSlug(resolved.ref),
    name: resolved.name,
    type: resolved.type,
    sourceImages: resolved.images,
    universeUrl: universeUrl(resolved.ref),
    iconUrl: resolved.iconUrl,
  }
}
