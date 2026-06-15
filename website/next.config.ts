import type { NextConfig } from "next"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

const appRoot = dirname(fileURLToPath(import.meta.url))

const nextConfig: NextConfig = {
  // Pin the workspace root to this directory. Without this, Next's root
  // inference walks up looking for a lockfile and finds a stray
  // ~/package-lock.json, treating the entire home folder (incl. the 12GB
  // mosaic pipeline tree) as the root — so dev file-tracing/watching scans
  // it and pegs the CPU. Both keys must point here: turbopack.root scopes
  // module resolution, outputFileTracingRoot scopes file tracing/watching.
  outputFileTracingRoot: appRoot,
  turbopack: {
    root: appRoot,
  },
}

export default nextConfig
