"use client"

// Paste a Roboflow Universe dataset URL; get a photo mosaic of that dataset.
//
// This component is only the front door: it takes the URL, drives the ingest,
// and then hands off to CanvasHero — the same UI the rest of the site uses, with
// its pan/zoom viewer, hover-a-tile-to-see-its-source, density controls and
// generated-mosaic cache. The two dataset-specific pieces are the tile source
// (`roboflowSource`) and the reference picker (project cover, or any image out
// of the dataset) that replaces CanvasHero's upload card.

import * as React from "react"

import { CanvasHero } from "@/components/canvas-hero"
import { RoboflowReferencePicker } from "@/components/roboflow-reference-picker"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { roboflowSource } from "@/lib/mosaic-source"
import {
  ROBOFLOW_INGEST_PATH,
  parseRoboflowUrl,
  type IngestStatus,
  type RoboflowDataset,
} from "@/lib/roboflow"

// A single dataset image should not be allowed to carpet the mosaic.
const MAX_TILE_REUSE = 24
const MIN_CELL_SIZE = 8

const EXAMPLE_URL =
  "https://universe.roboflow.com/joseph-nelson/chess-pieces-new"

async function startIngest(url: string): Promise<IngestStatus> {
  const response = await fetch(ROBOFLOW_INGEST_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  })
  const body = (await response.json()) as IngestStatus & { error?: string }
  if (!response.ok) throw new Error(body.error ?? "Could not start the ingest.")
  return body
}

async function pollIngest(
  slug: string,
  onStatus: (status: IngestStatus) => void,
  signal: AbortSignal
): Promise<RoboflowDataset> {
  for (;;) {
    if (signal.aborted) throw new Error("Cancelled")
    const response = await fetch(
      `${ROBOFLOW_INGEST_PATH}?slug=${encodeURIComponent(slug)}`,
      { signal }
    )
    const status = (await response.json()) as IngestStatus & { error?: string }
    if (!response.ok)
      throw new Error(status.error ?? "Lost track of the ingest.")
    onStatus(status)
    if (status.state === "error")
      throw new Error(status.error ?? "Ingest failed.")
    if (status.state === "ready") {
      if (!status.dataset) {
        throw new Error("The ingest finished without a dataset record.")
      }
      return status.dataset
    }
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
}

export function RoboflowMosaic() {
  const [url, setUrl] = React.useState("")
  const [ingesting, setIngesting] = React.useState(false)
  const [status, setStatus] = React.useState<IngestStatus | null>(null)
  const [dataset, setDataset] = React.useState<RoboflowDataset | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const abortRef = React.useRef<AbortController | null>(null)

  React.useEffect(() => () => abortRef.current?.abort(), [])

  // CanvasHero uses this as an effect dependency, so it has to be stable across
  // renders — otherwise the tile library reloads on every keystroke.
  const collection = React.useMemo(
    () => (dataset ? roboflowSource(dataset) : null),
    [dataset]
  )

  // Also memoized: CanvasHero renders this as a component, so a fresh identity
  // each render would remount the picker and drop its state (the loaded image
  // list, whether the grid dialog is open).
  const ReferencePicker = React.useMemo(() => {
    if (!dataset) return undefined
    function DatasetReferencePicker(props: {
      onSelect: (file: File) => void
      variant: "hero" | "panel"
    }) {
      return <RoboflowReferencePicker dataset={dataset!} {...props} />
    }
    return DatasetReferencePicker
  }, [dataset])

  const handleLoad = React.useCallback(async () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setError(null)
    setStatus(null)

    try {
      parseRoboflowUrl(url)
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : "Bad URL.")
      return
    }

    setIngesting(true)
    try {
      const started = await startIngest(url)
      setStatus(started)
      const resolved =
        started.state === "ready" && started.dataset
          ? started.dataset
          : await pollIngest(started.slug, setStatus, controller.signal)
      setDataset(resolved)
    } catch (runError) {
      if (controller.signal.aborted) return
      setError(runError instanceof Error ? runError.message : "Ingest failed.")
    } finally {
      setIngesting(false)
    }
  }, [url])

  const statusLine =
    ingesting && status
      ? `${status.step}${
          status.total > 0
            ? ` — ${Math.round((status.done / status.total) * 100)}%`
            : ""
        }`
      : null

  // The URL, with the action tucked into the right end.
  const datasetBar = (
    <div className="flex w-full min-w-0 flex-col items-center gap-2">
      <div className="relative w-full min-w-0">
        <Input
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !ingesting) void handleLoad()
          }}
          placeholder={EXAMPLE_URL}
          spellCheck={false}
          // The base Input is a low-contrast chip; as a standalone search bar it
          // needs a visible edge, especially floating over the mosaic. Height,
          // corners and left padding stay at the base Input's defaults, which
          // is also what lines it up with the sidebar toggle beside it.
          className="h-8 w-full border-border/60 bg-input/60 pr-32 shadow-sm backdrop-blur"
          aria-label="Roboflow Universe dataset URL"
        />
        <Button
          size="sm"
          // Fixed width so swapping the label for the spinner doesn't resize
          // the button (and animate that resize through the base transition).
          // Centred with `top-1` rather than a -translate-y-1/2: the base
          // Button presses with `active:translate-y-px`, which would replace
          // the centring transform and drop the button half its height.
          className="absolute top-1 right-1 h-6 w-28 px-3 text-xs"
          onClick={() => void handleLoad()}
          disabled={ingesting || !url.trim()}
        >
          {ingesting ? <Spinner /> : "Load Dataset"}
        </Button>
      </div>
      {statusLine && (
        <p className="text-xs text-muted-foreground tabular-nums">
          {statusLine}
        </p>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )

  return (
    <div className="flex min-h-svh flex-col">
      {collection && dataset ? (
        // Remounted per dataset so every piece of CanvasHero's state — library,
        // reference, cached mosaic — resets with the collection.
        <CanvasHero
          key={collection.id}
          collection={collection}
          maxTileReuse={MAX_TILE_REUSE}
          minCellSize={MIN_CELL_SIZE}
          hideCollectionLabel
          referencePicker={ReferencePicker}
          topBarSlot={datasetBar}
        />
      ) : (
        // Before a dataset is loaded there is no CanvasHero to host the bar, so
        // it gets its own centered landing state.
        <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-4 px-5 py-24 text-center">
          <h1 className="text-xl font-semibold tracking-tight">
            Roboflow dataset mosaic
          </h1>
          {datasetBar}
          {!ingesting && (
            <p className="text-sm text-muted-foreground">
              <button
                type="button"
                className="underline underline-offset-4"
                onClick={() => setUrl(EXAMPLE_URL)}
              >
                Try {EXAMPLE_URL}
              </button>
            </p>
          )}
        </div>
      )}
    </div>
  )
}
