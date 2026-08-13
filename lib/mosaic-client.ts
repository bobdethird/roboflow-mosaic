// Main-thread handle to the mosaic Web Worker. Wraps postMessage in a small
// promise/callback API so components don't deal with raw messages.

import type { Grid } from "./mosaic"
import type { HydrateItem, WorkerRequest, WorkerResponse } from "./mosaic-protocol"

export type GenerateResult = { assignment: Int32Array; base: ImageBitmap }

// Called with each in-progress snapshot as the mosaic fills in. The caller owns
// closing the bitmap after drawing it.
export type GenerateFrameCallback = (
  frame: ImageBitmap,
  done: number,
  total: number
) => void

export type GenerateProgressCallback = (done: number, total: number) => void

export type GenerateOptions = {
  maxTileReuse?: number
}

type Pending = {
  resolve: (result: GenerateResult) => void
  onFrame?: GenerateFrameCallback
  onProgress?: GenerateProgressCallback
}

export class MosaicEngine {
  private worker: Worker
  private reqId = 0
  private pending = new Map<number, Pending>()

  constructor() {
    this.worker = new Worker(new URL("./mosaic-worker.ts", import.meta.url), {
      type: "module",
    })
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      if (msg.type === "progress") {
        this.pending.get(msg.reqId)?.onProgress?.(msg.done, msg.total)
      } else if (msg.type === "progressFrame") {
        this.pending.get(msg.reqId)?.onFrame?.(msg.base, msg.done, msg.total)
      } else if (msg.type === "generated") {
        const entry = this.pending.get(msg.reqId)
        if (entry) {
          this.pending.delete(msg.reqId)
          entry.resolve({ assignment: msg.assignment, base: msg.base })
        }
      }
    }
  }

  private send(message: WorkerRequest) {
    this.worker.postMessage(message)
  }

  // Replay the shared library into the worker's store so it can match/render. The
  // worker fetches each tile's thumbnail lazily (by URL) when it's placed.
  hydrate(items: HydrateItem[]) {
    if (items.length) this.send({ type: "hydrate", items })
  }

  generate(
    cellSigs: Float32Array[],
    grid: Grid,
    ids: string[],
    angles: Float32Array,
    polys: Float32Array,
    offsets: Int32Array,
    width: number,
    height: number,
    onFrame?: GenerateFrameCallback,
    onProgress?: GenerateProgressCallback,
    options: GenerateOptions = {}
  ): Promise<GenerateResult> {
    const reqId = ++this.reqId
    return new Promise((resolve) => {
      this.pending.set(reqId, { resolve, onFrame, onProgress })
      // angles/polys/offsets are sent (cloned, not transferred) so the caller
      // keeps its copies for the crisp zoom overlay.
      this.send({
        type: "generate",
        reqId,
        cellSigs,
        grid,
        ids,
        width,
        height,
        angles,
        polys,
        offsets,
        maxTileReuse: options.maxTileReuse,
      })
    })
  }

  terminate() {
    this.worker.terminate()
  }
}
