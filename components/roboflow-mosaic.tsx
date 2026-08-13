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
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { ingestExportInBrowser } from "@/lib/roboflow-client-ingest"
import { roboflowSource } from "@/lib/mosaic-source"
import {
  ROBOFLOW_INGEST_PATH,
  parseRoboflowUrl,
  readJsonBody,
  type IngestStatus,
  type RoboflowDataset,
} from "@/lib/roboflow"

// A single dataset image should not be allowed to carpet the mosaic.
const MAX_TILE_REUSE = 24
const MIN_CELL_SIZE = 8

const EXAMPLE_URL =
  "https://universe.roboflow.com/joseph-nelson/chess-pieces-new"

// An ingest walks a fixed sequence of stages, and only the long one — building
// tiles — reports counts. Giving every stage its own share of the bar turns
// that into one percentage for the whole load, instead of a number that exists
// for a single stage and restarts at the next. Weights are rough durations and
// sum to 100, but an uncounted stage only parks at its own start, so the bar
// fills all the way just for a dataset that reports itself ready.
// Matched by prefix: the export-wait step carries Roboflow's own percentage in
// its label, and each ingest path (browser, server) reports only a subset.
const INGEST_STAGES: { step: string; weight: number }[] = [
  { step: "resolving dataset", weight: 4 },
  { step: "requesting export", weight: 6 },
  { step: "roboflow is generating", weight: 9 },
  { step: "downloading export", weight: 8 },
  { step: "reading export index", weight: 8 },
  { step: "building tiles", weight: 57 },
  { step: "fetching project cover image", weight: 3 },
  { step: "writing library", weight: 3 },
  { step: "publishing library", weight: 2 },
]

// Null is "nothing to say": an unrecognized stage with no counts, which leaves
// the bar wherever it already stood.
function ingestPercent(status: IngestStatus): number | null {
  if (status.state === "ready") return 100
  const step = status.step.toLowerCase()
  let start = 0
  for (const stage of INGEST_STAGES) {
    if (step.startsWith(stage.step)) {
      const fraction =
        status.total > 0 ? Math.min(1, status.done / status.total) : 0
      return start + stage.weight * fraction
    }
    start += stage.weight
  }
  return status.total > 0
    ? Math.min(100, (status.done / status.total) * 100)
    : null
}

async function startIngest(url: string): Promise<IngestStatus> {
  const response = await fetch(ROBOFLOW_INGEST_PATH, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url }),
  })
  const body = await readJsonBody<IngestStatus & { error?: string }>(response)
  if (!response.ok) throw new Error(body.error ?? "Could not start the ingest.")
  return body
}

async function pollIngest(
  slug: string,
  onStatus: (status: IngestStatus) => void,
  signal: AbortSignal
): Promise<RoboflowDataset> {
  const startedAt = Date.now()
  for (;;) {
    if (signal.aborted) throw new Error("Cancelled")
    const response = await fetch(
      `${ROBOFLOW_INGEST_PATH}?slug=${encodeURIComponent(slug)}`,
      { signal }
    )
    const status = await readJsonBody<IngestStatus & { error?: string }>(
      response
    )
    // A 404 is the poll landing on an instance that has not seen this job yet
    // (status lives in /tmp). Give the durable copy a few seconds to show up
    // rather than failing the default dataset on the first tick.
    if (response.status === 404 && Date.now() - startedAt < 20_000) {
      await new Promise((resolve) => setTimeout(resolve, 700))
      continue
    }
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
  // Status and its percentage travel together because the percentage is not a
  // pure function of the latest status: it is clamped against the previous one
  // so the bar never walks backwards mid-load, which a poll landing on a
  // coarser step (or a stage with no counts) would otherwise do.
  const [progress, setProgress] = React.useState<{
    status: IngestStatus
    percent: number
  } | null>(null)
  const [dataset, setDataset] = React.useState<RoboflowDataset | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const abortRef = React.useRef<AbortController | null>(null)

  React.useEffect(() => () => abortRef.current?.abort(), [])

  const report = React.useCallback((status: IngestStatus) => {
    setProgress((current) => {
      const floor = current?.percent ?? 0
      const next = ingestPercent(status)
      return { status, percent: next === null ? floor : Math.max(floor, next) }
    })
  }, [])

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
    // Capture the submitted value. The field intentionally remains editable
    // while the current dataset is displayed (and while a new one loads), so
    // later keystrokes must not change the request already in flight.
    const requestedUrl = url.trim()

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setError(null)
    setProgress(null)

    try {
      parseRoboflowUrl(requestedUrl)
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : "Bad URL.")
      return
    }

    setIngesting(true)
    try {
      report({
        slug: "",
        state: "running",
        step: "Requesting export",
        done: 0,
        total: 0,
        updatedAt: new Date().toISOString(),
      })
      const started = await startIngest(requestedUrl)
      report(started)
      if (started.state === "ready" && started.dataset) {
        setDataset(started.dataset)
        return
      }
      if (started.exportUrl && started.dataset) {
        const built = await ingestExportInBrowser(
          {
            dataset: started.dataset,
            exportUrl: started.exportUrl,
            iconUrl: started.iconUrl,
          },
          (stage) => {
            if (controller.signal.aborted) return
            report({
              slug: started.slug,
              state: "running",
              step: stage.step,
              done: stage.done,
              total: stage.total,
              updatedAt: new Date().toISOString(),
            })
          },
          controller.signal
        )
        setDataset(built.dataset)
        return
      }
      const resolved = await pollIngest(started.slug, report, controller.signal)
      setDataset(resolved)
    } catch (runError) {
      if (controller.signal.aborted) return
      setError(runError instanceof Error ? runError.message : "Ingest failed.")
    } finally {
      setIngesting(false)
    }
  }, [url, report])

  const shownPercent = progress ? Math.round(progress.percent) : 0

  // The URL, with the action tucked into the right end.
  const datasetBar = (
    <div className="flex w-full min-w-0 flex-col items-center gap-2">
      <div className="relative w-full min-w-0">
        <Input
          value={url}
          onChange={(event) => {
            setUrl(event.target.value)
            if (error) setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !ingesting) void handleLoad()
          }}
          placeholder={EXAMPLE_URL}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          inputMode="url"
          // The base Input is a low-contrast chip; as a standalone search bar it
          // needs a visible edge, especially floating over the mosaic. Height,
          // corners and left padding stay at the base Input's defaults, which
          // is also what lines it up with the sidebar toggle beside it.
          // CanvasHero disables selection across its image workspace. Override
          // that here so the loaded-state search bar keeps normal caret and
          // text-selection behavior when someone pastes or edits another URL.
          className="h-8 w-full select-text border-border/60 bg-input/60 pr-32 shadow-sm backdrop-blur"
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
      {ingesting && progress && (
        <div className="flex w-full min-w-0 flex-col gap-1.5">
          <Progress
            value={shownPercent}
            className="h-1"
            aria-label="Dataset load progress"
          />
          <p className="text-center text-xs text-muted-foreground tabular-nums">
            {progress.status.step} — {shownPercent}%
          </p>
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )

  return (
    <div className="relative flex min-h-svh flex-col">
      {collection && dataset ? (
        // Remounted per dataset so every piece of CanvasHero's state —
        // library, reference, cached mosaic — resets with the collection.
        // The dataset field is hosted as CanvasHero's top bar so it lives on
        // the mosaic canvas and recenters with the image when the sidebar opens.
        <CanvasHero
          key={collection.id}
          collection={collection}
          topBarSlot={datasetBar}
          maxTileReuse={MAX_TILE_REUSE}
          minCellSize={MIN_CELL_SIZE}
          hideCollectionLabel
          referencePicker={ReferencePicker}
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
