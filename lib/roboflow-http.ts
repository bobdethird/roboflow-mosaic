// Small helpers shared by the Roboflow route handlers.

import { RoboflowUrlError } from "./roboflow"
import { RoboflowApiError } from "./roboflow-api"
import { IngestError } from "./roboflow-resolve"

export function json(
  body: unknown,
  status = 200,
  extraHeaders: HeadersInit = {}
): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...extraHeaders },
  })
}

export function clientAddress(request: Request): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip")?.trim() ||
    "unknown"
  )
}

export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin")
  if (!origin) return true
  try {
    return new URL(origin).origin === new URL(request.url).origin
  } catch {
    return false
  }
}

export function errorMessage(error: unknown, fallback = "Request failed."): string {
  if (
    error instanceof RoboflowUrlError ||
    error instanceof RoboflowApiError ||
    error instanceof IngestError
  ) {
    return error.message
  }
  if (error instanceof Error) return error.message
  return fallback
}
