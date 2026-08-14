// Resolve a Roboflow Universe URL to a dataset version. JSON only — the
// browser seeds the tile library on the user's machine.

import {
  RoboflowUrlError,
  parseRoboflowUrl,
} from "@/lib/roboflow"
import { RoboflowApiError } from "@/lib/roboflow-api"
import { consumeResolveRateLimit } from "@/lib/roboflow-control"
import {
  clientAddress,
  errorMessage,
  isSameOrigin,
  json,
  readApiKeyHeader,
} from "@/lib/roboflow-http"
import { IngestError, resolveDataset, resolvedRecord } from "@/lib/roboflow-resolve"
import { IS_VERCEL } from "@/lib/roboflow-store"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 30

export async function POST(request: Request): Promise<Response> {
  if (IS_VERCEL && !isSameOrigin(request)) {
    return json({ error: "Cross-origin resolve requests are not allowed." }, 403)
  }

  let body: { url?: string }
  try {
    body = (await request.json()) as { url?: string }
  } catch {
    return json({ error: "Expected a JSON body with a `url`." }, 400)
  }

  let apiKey: string | undefined
  try {
    apiKey = readApiKeyHeader(request)
  } catch (error) {
    return json({ error: errorMessage(error) }, 400)
  }

  try {
    const ref = parseRoboflowUrl(body.url ?? "")

    if (IS_VERCEL && !apiKey) {
      const rate = await consumeResolveRateLimit(clientAddress(request))
      if (!rate.allowed) {
        return json(
          {
            error: `Too many dataset loads. Try again in ${rate.retryAfterSeconds} seconds.`,
            retryAfter: rate.retryAfterSeconds,
          },
          429,
          { "retry-after": String(rate.retryAfterSeconds) }
        )
      }
    }

    const resolved = await resolveDataset(ref, { apiKey })
    return json(resolvedRecord(resolved))
  } catch (error) {
    const status =
      error instanceof RoboflowUrlError || error instanceof IngestError
        ? 400
        : error instanceof RoboflowApiError && error.status
          ? error.status
          : 400
    return json({ error: errorMessage(error, "Could not resolve that dataset.") }, status)
  }
}
