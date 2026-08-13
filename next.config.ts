import type { NextConfig } from "next"

// The package is CommonJS (see package.json), so `import.meta.url` is not
// available here; Next always loads this config with the project as the cwd.
const appRoot = process.cwd()
const isVercel = process.env.VERCEL === "1"

const tracingConfig: NextConfig = {
  // Runtime data is never an application dependency. Without this exclusion,
  // Turbopack traces every local thumbnail into both Roboflow route bundles.
  outputFileTracingExcludes: {
    "/api/roboflow/**": ["./.roboflow-cache/**/*"],
  },
}

const localRootConfig: NextConfig = {
  ...tracingConfig,
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

const nextConfig: NextConfig = isVercel ? tracingConfig : localRootConfig

export default nextConfig
