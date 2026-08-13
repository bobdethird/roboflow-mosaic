// Forwards a Range (or whole-body) request to an allowlisted Roboflow URL.
// The browser ingest reads the export zip through here so CORS does not matter.

import { proxyRoboflow } from "@/lib/roboflow-proxy"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 60

export function GET(request: Request): Promise<Response> {
  return proxyRoboflow(request)
}
