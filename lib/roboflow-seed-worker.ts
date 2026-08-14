// Seed worker: decode one thumbnail into a signature + 192px JPEG. The main
// thread keeps a pool of these so Sharp never runs on the Vercel CPU.

import { decodeOutputs } from "./roboflow-client-decode"

export type SeedRequest = {
  reqId: number
  bytes: ArrayBuffer
}

export type SeedResponse =
  | {
      reqId: number
      ok: true
      width: number
      height: number
      signature: ArrayBuffer
      thumbnail: ArrayBuffer
    }
  | { reqId: number; ok: false; message: string }

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SeedRequest>) => void) | null
  postMessage(message: SeedResponse, transfer?: Transferable[]): void
}

scope.onmessage = (event: MessageEvent<SeedRequest>) => {
  const { reqId, bytes } = event.data
  void decodeOutputs(bytes).then(
    (decoded) => {
      const signature = decoded.signature.buffer.slice(
        decoded.signature.byteOffset,
        decoded.signature.byteOffset + decoded.signature.byteLength
      ) as ArrayBuffer
      scope.postMessage(
        {
          reqId,
          ok: true,
          width: decoded.width,
          height: decoded.height,
          signature,
          thumbnail: decoded.thumbnail,
        },
        [signature, decoded.thumbnail]
      )
    },
    (error: unknown) => {
      scope.postMessage({
        reqId,
        ok: false,
        message: error instanceof Error ? error.message : "Could not decode image.",
      })
    }
  )
}
