"use client"

// Paste a Roboflow Universe dataset URL; get a photo mosaic of that dataset.
//
// This component is only the front door: it takes the URL, seeds the library
// in the browser, and then hands off to CanvasHero — the same UI the rest of
// the site uses, with
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
import { roboflowSource } from "@/lib/mosaic-source"
import {
  parseRoboflowUrl,
  type IngestStatus,
  type RoboflowDataset,
} from "@/lib/roboflow"
import {
  ingestDatasetInBrowser,
  resolveRemoteDataset,
} from "@/lib/roboflow-client-ingest"
import { SEARCH_RESULT_CAP } from "@/lib/roboflow-limits"

// A single dataset image should not be allowed to carpet the mosaic.
const MAX_TILE_REUSE = 24
const MIN_CELL_SIZE = 8

const EXAMPLE_URL =
  "https://universe.roboflow.com/microsoft/coco"

const DatasetContext = React.createContext<RoboflowDataset | null>(null)

// An ingest walks a fixed sequence of stages, and only the long one — seeding
// tiles — reports counts. Giving every stage its own share of the bar turns
// that into one percentage for the whole load, instead of a number that exists
// for a single stage and restarts at the next. Weights are rough durations and
// sum to 100, but an uncounted stage only parks at its own start, so the bar
// fills all the way just for a dataset that reports itself ready.
const INGEST_STAGES: { step: string; weight: number }[] = [
  { step: "resolving dataset", weight: 6 },
  { step: "searching images", weight: 12 },
  { step: "seeding tiles", weight: 82 },
]

// Search rejects offsets at SEARCH_RESULT_CAP. Progress copy and the bar use
// this so a large dataset does not advertise a 20k total the API cannot reach.
// Sampling is unchanged — this is display only.
function searchDisplayLimit(available: number): number {
  if (available <= 0) return 0
  return Math.min(available, SEARCH_RESULT_CAP)
}

// Null is "nothing to say": an unrecognized stage with no counts, which leaves
// the bar wherever it already stood.
function ingestPercent(status: IngestStatus): number | null {
  if (status.state === "ready") return 100
  const step = status.step.toLowerCase()
  const total = searchDisplayLimit(status.total)
  let start = 0
  for (const stage of INGEST_STAGES) {
    if (step.startsWith(stage.step)) {
      const fraction = total > 0 ? Math.min(1, status.done / total) : 0
      return start + stage.weight * fraction
    }
    start += stage.weight
  }
  return total > 0 ? Math.min(100, (status.done / total) * 100) : null
}

function statusFromProgress(
  slug: string,
  step: string,
  done: number,
  total: number,
  dataset?: RoboflowDataset
): IngestStatus {
  return {
    slug,
    state: "running",
    step,
    done,
    total,
    updatedAt: new Date().toISOString(),
    dataset,
    availableImages: dataset?.imageCount,
    sourceImages: dataset?.sourceImages,
  }
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  )
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
  const inFlightUrlRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    return () => abortRef.current?.abort()
  }, [])

  const report = React.useCallback((status: IngestStatus) => {
    setProgress((current) => {
      const floor = current?.percent ?? 0
      const next = ingestPercent(status)
      return { status, percent: next === null ? floor : Math.max(floor, next) }
    })
  }, [])

  // CanvasHero uses this as an effect dependency, so it has to be stable across
  // snapshot updates — otherwise the tile library remounts on every batch.
  const collection = React.useMemo(
    () => (dataset ? roboflowSource(dataset) : null),
    // Snapshot updates must not remount CanvasHero; later revisions are
    // loaded through `libraryRevision` / `loadLibrary({ expectedVersion })`.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on slug
    [dataset?.slug]
  )

  // Stable identity: CanvasHero renders this as a component, so a fresh
  // function each render would remount the picker and drop its state.
  const ReferencePicker = React.useMemo(() => {
    if (!dataset?.slug) return undefined
    function DatasetReferencePicker(props: {
      onSelect: (file: File) => void
      variant: "hero" | "panel"
    }) {
      const current = React.useContext(DatasetContext)
      if (!current) return null
      return <RoboflowReferencePicker dataset={current} {...props} />
    }
    return DatasetReferencePicker
  }, [dataset?.slug])

  const handleLoad = React.useCallback(async () => {
    // Capture the submitted value. The field intentionally remains editable
    // while the current dataset is displayed (and while a new one loads), so
    // later keystrokes must not change the request already in flight.
    const requestedUrl = url.trim()
    if (!requestedUrl || inFlightUrlRef.current === requestedUrl) return

    try {
      parseRoboflowUrl(requestedUrl)
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : "Bad URL.")
      return
    }

    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    inFlightUrlRef.current = requestedUrl
    setError(null)
    setProgress(null)
    setIngesting(true)
    try {
      report(statusFromProgress("", "Resolving dataset", 0, 0))
      const catalog = await resolveRemoteDataset(requestedUrl, {
        signal: controller.signal,
      })
      report(statusFromProgress(catalog.slug, "Searching images", 0, 0))
      const finished = await ingestDatasetInBrowser(catalog, {
        signal: controller.signal,
        onProgress: (next) => {
          report(
            statusFromProgress(catalog.slug, next.step, next.done, next.total)
          )
        },
        onSnapshot: (snapshot) => {
          setDataset(snapshot)
          report(
            statusFromProgress(
              snapshot.slug,
              "Seeding tiles",
              snapshot.imageCount,
              snapshot.sourceImages ?? snapshot.imageCount,
              snapshot
            )
          )
        },
      })
      setDataset(finished)
      report({
        ...statusFromProgress(
          finished.slug,
          "Ready",
          finished.imageCount,
          finished.sourceImages ?? finished.imageCount,
          finished
        ),
        state: "ready",
      })
    } catch (runError) {
      if (controller.signal.aborted || isAbortError(runError)) return
      setError(runError instanceof Error ? runError.message : "Ingest failed.")
    } finally {
      if (abortRef.current === controller) {
        inFlightUrlRef.current = null
        setIngesting(false)
      }
    }
  }, [url, report])

  const shownPercent = progress ? Math.round(progress.percent) : 0
  const readyCount =
    dataset?.imageCount ??
    progress?.status.availableImages ??
    progress?.status.dataset?.imageCount
  const sourceCount =
    dataset?.sourceImages ??
    progress?.status.sourceImages ??
    progress?.status.dataset?.sourceImages ??
    progress?.status.total
  const step = progress?.status.step.toLowerCase() ?? ""
  const tilingTotal = progress ? searchDisplayLimit(progress.status.total) : 0
  const displaySource = searchDisplayLimit(sourceCount ?? 0)
  const seedingCount =
    (step.startsWith("seeding tiles") || step.startsWith("searching images")) &&
    progress &&
    tilingTotal > 0
      ? `${Math.min(progress.status.done, tilingTotal).toLocaleString()} / ${tilingTotal.toLocaleString()} images`
      : ingesting && readyCount && displaySource && displaySource > readyCount
        ? `${readyCount.toLocaleString()} of ${displaySource.toLocaleString()} images ready`
        : readyCount
          ? `${readyCount.toLocaleString()} images ready`
          : null

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
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )

  const tilingProgress = (
    <div className="flex w-full min-w-0 flex-col items-center gap-3">
      <Spinner />
      {progress && (
        <>
          <Progress
            value={shownPercent}
            className="h-1"
            aria-label="Dataset load progress"
          />
          <p className="text-center text-xs text-muted-foreground tabular-nums">
            {progress.status.step} — {seedingCount && `${seedingCount} — `}
            {shownPercent}%
          </p>
        </>
      )}
    </div>
  )

  return (
    <div className="relative flex min-h-svh flex-col">
      {collection && dataset && !ingesting ? (
        // Remounted per dataset so every piece of CanvasHero's state —
        // library, reference, cached mosaic — resets with the collection.
        // Hidden while tiles are still seeding so generate cannot run on a
        // half-loaded library. The dataset field is hosted as CanvasHero's
        // top bar so it lives on the mosaic canvas and recenters with the
        // image when the sidebar opens.
        <DatasetContext.Provider value={dataset}>
          <CanvasHero
            key={collection.id}
            collection={collection}
            topBarSlot={datasetBar}
            maxTileReuse={MAX_TILE_REUSE}
            minCellSize={MIN_CELL_SIZE}
            hideCollectionLabel
            referencePicker={ReferencePicker}
            libraryRevision={dataset.libraryVersion}
            expectedPhotoCount={dataset.imageCount}
          />
        </DatasetContext.Provider>
      ) : ingesting ? (
        // Tiling is in progress: loading only — no generate controls.
        <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-4 px-5 py-24 text-center">
          <h1 className="text-xl font-semibold tracking-tight">
            Roboflow dataset mosaic
          </h1>
          {tilingProgress}
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      ) : (
        // Before a dataset is loaded there is no CanvasHero to host the bar, so
        // it gets its own centered landing state.
        <div className="mx-auto flex w-full max-w-2xl flex-col items-center gap-4 px-5 py-24 text-center">
          <h1 className="text-xl font-semibold tracking-tight">
            Roboflow dataset mosaic
          </h1>
          {datasetBar}
          <p className="text-sm text-muted-foreground">
            <button
              type="button"
              className="underline underline-offset-4"
              onClick={() => setUrl(EXAMPLE_URL)}
            >
              Try {EXAMPLE_URL}
            </button>
          </p>
        </div>
      )}
    </div>
  )
}
