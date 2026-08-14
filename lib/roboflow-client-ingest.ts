// Browser-side Roboflow ingest: the server only resolves the project and
// pages image metadata. Thumbnails download on the user's machine, and
// decode / signature / JPEG seeding run in a pool of local workers.

import {
  ROBOFLOW_IMAGES_PATH,
  ROBOFLOW_RESOLVE_PATH,
  ROBOFLOW_THUMB_PATH,
  readJsonBody,
  type RoboflowDataset,
} from "./roboflow"
import {
  CLIENT_FETCH_CONCURRENCY,
  MAX_INDEXED_IMAGES,
  MIN_PARTIAL_TILES,
  SEARCH_PAGE_SIZE,
  SNAPSHOT_BATCH,
  TILE_BUDGET,
} from "./roboflow-limits"
import { evenSampleIndices } from "./roboflow-sample"
import { decodeIcon, decodeOutputs } from "./roboflow-client-decode"
import {
  createLocalPack,
  registerPack,
  type LocalPack,
  type LocalTile,
} from "./roboflow-pack"
import type { SeedRequest, SeedResponse } from "./roboflow-seed-worker"

export type CatalogImage = {
  id: string
  name?: string
  thumbUrl: string | null
}

export type ResolvedCatalog = {
  workspace: string
  project: string
  version: number
  slug: string
  name: string
  type?: string
  sourceImages: number
  universeUrl: string
  iconUrl?: string
}

export type ClientIngestProgress = {
  step: string
  done: number
  total: number
}

const JSON_HEADERS: HeadersInit = { "content-type": "application/json" }

export async function resolveRemoteDataset(
  url: string,
  options: { signal?: AbortSignal } = {}
): Promise<ResolvedCatalog> {
  const response = await fetch(ROBOFLOW_RESOLVE_PATH, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ url }),
    signal: options.signal,
  })
  const body = await readJsonBody<ResolvedCatalog & { error?: string }>(response)
  if (!response.ok) throw new Error(body.error ?? "Could not resolve that dataset.")
  return body
}

async function fetchImagePage(
  ref: Pick<ResolvedCatalog, "workspace" | "project">,
  offset: number,
  options: { signal?: AbortSignal } = {}
): Promise<{ offset: number; total: number; results: CatalogImage[] }> {
  const response = await fetch(ROBOFLOW_IMAGES_PATH, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({
      workspace: ref.workspace,
      project: ref.project,
      offset,
      limit: SEARCH_PAGE_SIZE,
    }),
    signal: options.signal,
  })
  const body = await readJsonBody<{
    offset: number
    total: number
    results: CatalogImage[]
    error?: string
  }>(response)
  if (!response.ok) throw new Error(body.error ?? "Could not list project images.")
  return body
}

async function fetchThumbBytes(
  image: CatalogImage,
  ref: Pick<ResolvedCatalog, "workspace" | "project">,
  options: {
    signal?: AbortSignal
    preferProxy: { value: boolean }
  }
): Promise<ArrayBuffer | null> {
  if (image.thumbUrl && !options.preferProxy.value) {
    try {
      const response = await fetch(image.thumbUrl, {
        signal: options.signal,
        mode: "cors",
        cache: "no-store",
      })
      if (response.ok) return response.arrayBuffer()
    } catch {
      options.preferProxy.value = true
    }
  }

  const params = new URLSearchParams()
  if (image.thumbUrl) params.set("url", image.thumbUrl)
  else {
    params.set("workspace", ref.workspace)
    params.set("project", ref.project)
    params.set("id", image.id)
  }
  const response = await fetch(`${ROBOFLOW_THUMB_PATH}?${params}`, {
    signal: options.signal,
  })
  if (!response.ok) return null
  return response.arrayBuffer()
}

async function tileIdFor(imageId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-1",
    new TextEncoder().encode(imageId)
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  )
    .join("")
    .slice(0, 16)
}

type SeedJob = {
  bytes: ArrayBuffer
  resolve: (decoded: Awaited<ReturnType<typeof decodeOutputs>>) => void
  reject: (error: Error) => void
}

class SeedPool {
  private readonly workers: Worker[] = []
  private readonly idle: Worker[] = []
  private readonly queue: SeedJob[] = []
  private readonly pending = new Map<Worker, SeedJob>()
  private reqId = 0
  private fallback = false

  constructor(size: number) {
    try {
      for (let i = 0; i < Math.max(1, size); i++) {
        const worker = new Worker(
          new URL("./roboflow-seed-worker.ts", import.meta.url),
          { type: "module" }
        )
        worker.onmessage = (event: MessageEvent<SeedResponse>) => {
          this.settle(worker, event.data)
        }
        worker.onerror = () => {
          this.fallback = true
          this.fail(worker, new Error("The seed worker stopped unexpectedly."))
        }
        this.workers.push(worker)
        this.idle.push(worker)
      }
    } catch {
      this.fallback = true
    }
  }

  decode(bytes: ArrayBuffer): Promise<Awaited<ReturnType<typeof decodeOutputs>>> {
    if (this.fallback) return decodeOutputs(bytes)
    return new Promise((resolve, reject) => {
      this.queue.push({ bytes, resolve, reject })
      this.pump()
    })
  }

  terminate(): void {
    for (const worker of this.workers) worker.terminate()
    this.workers.length = 0
    this.idle.length = 0
    this.pending.clear()
    const cancelled = new Error("Cancelled")
    for (const job of this.queue) job.reject(cancelled)
    this.queue.length = 0
  }

  private pump(): void {
    while (this.idle.length && this.queue.length) {
      const worker = this.idle.pop()
      const job = this.queue.shift()
      if (!worker || !job) return
      const reqId = ++this.reqId
      this.pending.set(worker, job)
      const message: SeedRequest = { reqId, bytes: job.bytes }
      try {
        worker.postMessage(message, [job.bytes])
      } catch (error) {
        this.pending.delete(worker)
        this.idle.push(worker)
        job.reject(
          error instanceof Error ? error : new Error("Could not decode image.")
        )
      }
    }
  }

  private settle(worker: Worker, response: SeedResponse): void {
    const job = this.pending.get(worker)
    this.pending.delete(worker)
    this.idle.push(worker)
    if (!job) {
      this.pump()
      return
    }
    if (!response.ok) {
      job.reject(new Error(response.message))
    } else {
      job.resolve({
        width: response.width,
        height: response.height,
        signature: new Uint8Array(response.signature),
        thumbnail: response.thumbnail,
      })
    }
    this.pump()
  }

  private fail(worker: Worker, error: Error): void {
    const job = this.pending.get(worker)
    this.pending.delete(worker)
    if (job) job.reject(error)
    this.pump()
  }
}

function livePool<T>(
  limit: number,
  task: (item: T) => Promise<void>
): { push: (item: T) => void; end: () => Promise<void> } {
  const queue: T[] = []
  const waiters: Array<() => void> = []
  let ended = false
  let failure: unknown = null

  const notify = () => {
    while (waiters.length) waiters.pop()?.()
  }

  const take = async (): Promise<T | undefined> => {
    for (;;) {
      if (failure) return undefined
      const item = queue.shift()
      if (item) return item
      if (ended) return undefined
      await new Promise<void>((resolve) => {
        waiters.push(resolve)
      })
    }
  }

  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    for (;;) {
      const item = await take()
      if (!item) return
      try {
        await task(item)
      } catch (error) {
        failure ??= error
        ended = true
        notify()
        return
      }
    }
  })

  return {
    push(item) {
      if (ended || failure) return
      queue.push(item)
      notify()
    },
    async end() {
      ended = true
      notify()
      await Promise.all(workers)
      if (failure) throw failure
    },
  }
}

function datasetFromPack(
  catalog: ResolvedCatalog,
  pack: LocalPack,
  sourceImages: number
): RoboflowDataset {
  return {
    workspace: catalog.workspace,
    project: catalog.project,
    version: catalog.version,
    slug: catalog.slug,
    name: catalog.name,
    type: catalog.type,
    imageCount: pack.photoCount,
    sourceImages: sourceImages > pack.photoCount ? sourceImages : undefined,
    universeUrl: catalog.universeUrl,
    hasIcon: pack.hasIcon,
    libraryVersion: pack.version,
  }
}

export async function ingestDatasetInBrowser(
  catalog: ResolvedCatalog,
  options: {
    signal?: AbortSignal
    budget?: number
    onProgress: (progress: ClientIngestProgress) => void
    onSnapshot: (dataset: RoboflowDataset) => void
  }
): Promise<RoboflowDataset> {
  const budget = options.budget ?? TILE_BUDGET
  const pack = createLocalPack(catalog.slug)
  const preferProxy = { value: false }
  const pool = new SeedPool(
    typeof navigator === "undefined" ? 2 : navigator.hardwareConcurrency || 4
  )
  let lastPublished = 0
  let sourceImages = catalog.sourceImages
  let registered = false

  const publish = (force: boolean) => {
    if (!pack.photoCount) return
    const due =
      force ||
      (lastPublished === 0 && pack.photoCount >= MIN_PARTIAL_TILES) ||
      (lastPublished > 0 && pack.photoCount - lastPublished >= SNAPSHOT_BATCH)
    if (!due) return
    if (!registered) {
      registerPack(pack)
      registered = true
    }
    lastPublished = pack.photoCount
    options.onSnapshot(datasetFromPack(catalog, pack, sourceImages))
  }

  const iconJob = catalog.iconUrl
    ? fetchThumbBytes(
        { id: "icon", thumbUrl: catalog.iconUrl },
        catalog,
        { signal: options.signal, preferProxy }
      )
        .then(async (bytes) => {
          if (!bytes || options.signal?.aborted) return
          const icon = await decodeIcon(bytes)
          pack.setIcon(icon)
          if (registered) {
            options.onSnapshot(datasetFromPack(catalog, pack, sourceImages))
          }
        })
        .catch(() => undefined)
    : Promise.resolve()

  options.onProgress({ step: "Searching images", done: 0, total: 0 })

  const seeding = livePool(CLIENT_FETCH_CONCURRENCY, async (image: CatalogImage) => {
    options.signal?.throwIfAborted()
    if (pack.photoCount >= budget) return
    const bytes = await fetchThumbBytes(image, catalog, {
      signal: options.signal,
      preferProxy,
    })
    if (!bytes) return
    if (pack.photoCount >= budget) return
    try {
      const [decoded, id] = await Promise.all([
        pool.decode(bytes),
        tileIdFor(image.id),
      ])
      if (pack.photoCount >= budget) return
      const tile: LocalTile = {
        id,
        w: decoded.width,
        h: decoded.height,
        file: image.name,
        signature: decoded.signature,
        thumbnail: new Blob([decoded.thumbnail], { type: "image/jpeg" }),
      }
      pack.addTiles([tile])
      options.onProgress({
        step: "Seeding tiles",
        done: pack.photoCount,
        total: Math.min(budget, sourceImages || pack.photoCount),
      })
      publish(false)
    } catch {
      // One unreadable thumb must not stop the rest of the dataset.
    }
  })

  try {
    let index = 0
    let offset = 0
    let wanted: Set<number> | null = null

    for (;;) {
      options.signal?.throwIfAborted()
      if (pack.photoCount >= budget) break
      const page = await fetchImagePage(catalog, offset, {
        signal: options.signal,
      })
      sourceImages = Math.max(page.total, sourceImages)
      if (!page.results.length) break

      if (!wanted) {
        const total = Math.max(page.total, page.results.length)
        const take = Math.min(budget, MAX_INDEXED_IMAGES, total)
        wanted = evenSampleIndices(total, take)
        options.onProgress({
          step: "Searching images",
          done: 0,
          total: wanted.size,
        })
      }

      for (const image of page.results) {
        if (wanted.has(index++)) seeding.push(image)
      }
      if (pack.photoCount === 0) {
        options.onProgress({
          step: "Searching images",
          done: Math.min(index, page.total || index),
          total: page.total || wanted.size,
        })
      }

      offset += page.results.length
      if (
        page.total > 0
          ? offset >= page.total
          : page.results.length < SEARCH_PAGE_SIZE
      ) {
        break
      }
    }

    await seeding.end()
    await iconJob
    publish(true)
  } catch (error) {
    await seeding.end().catch(() => undefined)
    if (!pack.photoCount) {
      pack.release()
      throw error
    }
    publish(true)
  } finally {
    pool.terminate()
  }

  if (!pack.photoCount) {
    pack.release()
    throw new Error(
      sourceImages
        ? "None of the dataset's images could be read."
        : "The project contained no images."
    )
  }
  if (!registered) {
    registerPack(pack)
    registered = true
  }
  return datasetFromPack(catalog, pack, sourceImages)
}
