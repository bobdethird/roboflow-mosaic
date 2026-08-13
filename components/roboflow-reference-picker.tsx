"use client"

// Chooses what a Roboflow dataset's mosaic reproduces. Two sources, both from
// the dataset itself:
//
//   Project cover — the image the dataset's author picked to represent it.
//   From dataset  — any single image in the set, chosen from a grid.
//
// Either way the result is handed back as a `File`, which is exactly what
// CanvasHero's upload card produces, so nothing downstream changes.

import * as React from "react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import {
  ICON_FILE,
  ROBOFLOW_COVER_PATH,
  readJsonBody,
  roboflowAssetUrl,
  roboflowThumbPath,
  type RoboflowDataset,
} from "@/lib/roboflow"
import { loadRoboflowManifest } from "@/lib/roboflow-library"

// How many thumbnails to put in the grid at once. Datasets run to thousands of
// images, and every tile is a separate request, so they come in pages.
const PAGE_SIZE = 120

async function urlToFile(url: string, name: string): Promise<File> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Could not load that image (${response.status}).`)
  }
  const blob = await response.blob()
  return new File([blob], name, { type: blob.type || "image/jpeg" })
}

type PickerProps = {
  dataset: RoboflowDataset
  onSelect: (file: File) => void
  variant: "hero" | "panel"
}

export function RoboflowReferencePicker({
  dataset,
  onSelect,
  variant,
}: PickerProps) {
  const [busy, setBusy] = React.useState<null | "cover" | "dataset">(null)
  const [error, setError] = React.useState<string | null>(null)
  const [open, setOpen] = React.useState(false)
  const [ids, setIds] = React.useState<string[] | null>(null)
  const [shown, setShown] = React.useState(PAGE_SIZE)

  const chooseCover = React.useCallback(async () => {
    setError(null)
    setBusy("cover")
    try {
      // A dataset ingested before covers were saved has everything else on
      // disk; pull just the cover rather than re-ingesting.
      if (!dataset.hasIcon) {
        const response = await fetch(ROBOFLOW_COVER_PATH, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slug: dataset.slug }),
        })
        const body = await readJsonBody<{
          hasIcon?: boolean
          error?: string
        }>(response)
        if (!response.ok || !body.hasIcon) {
          throw new Error(body.error ?? "Could not fetch the cover image.")
        }
      }
      onSelect(
        await urlToFile(
          roboflowAssetUrl(dataset.slug, ICON_FILE),
          `${dataset.project}-cover.jpg`
        )
      )
    } catch (coverError) {
      setError(
        coverError instanceof Error
          ? coverError.message
          : "Could not use the project cover."
      )
    } finally {
      setBusy(null)
    }
  }, [dataset, onSelect])

  const openGrid = React.useCallback(async () => {
    setError(null)
    setOpen(true)
    if (ids) return
    setBusy("dataset")
    try {
      const manifest = await loadRoboflowManifest(dataset.slug)
      setIds(manifest.photos.map((photo) => photo.id))
    } catch (gridError) {
      setError(
        gridError instanceof Error
          ? gridError.message
          : "Could not list the dataset's images."
      )
    } finally {
      setBusy(null)
    }
  }, [dataset.slug, ids])

  const pickFromDataset = React.useCallback(
    async (id: string) => {
      setError(null)
      setOpen(false)
      try {
        onSelect(
          await urlToFile(
            roboflowAssetUrl(dataset.slug, roboflowThumbPath(id)),
            `${dataset.project}-${id}.jpg`
          )
        )
      } catch (pickError) {
        setError(
          pickError instanceof Error
            ? pickError.message
            : "Could not use that image."
        )
      }
    },
    [dataset.project, dataset.slug, onSelect]
  )

  const hero = variant === "hero"

  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        hero && "items-center justify-center rounded-2xl border border-dashed p-8"
      )}
    >
      {hero && (
        <p className="text-muted-foreground mb-1 text-center text-sm">
          Pick what this dataset should reassemble into
        </p>
      )}
      <div className={cn("flex gap-2", hero ? "flex-row" : "flex-col")}>
        <Button
          variant={hero ? "default" : "outline"}
          size={hero ? "default" : "sm"}
          onClick={() => void chooseCover()}
          disabled={busy !== null}
        >
          {busy === "cover" ? "Loading…" : "Project cover"}
        </Button>

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button
              variant="outline"
              size={hero ? "default" : "sm"}
              onClick={() => void openGrid()}
              disabled={busy !== null}
            >
              From dataset
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[80vh] max-w-3xl overflow-hidden">
            <DialogHeader>
              <DialogTitle>Pick a reference image</DialogTitle>
              <DialogDescription>
                Any image from {dataset.name}. The mosaic will rebuild it out of
                the whole dataset.
              </DialogDescription>
            </DialogHeader>
            <div className="max-h-[60vh] overflow-y-auto">
              {ids === null ? (
                <p className="text-muted-foreground p-4 text-sm">
                  Loading the dataset&rsquo;s images…
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-5 md:grid-cols-6">
                    {ids.slice(0, shown).map((id) => (
                      <button
                        key={id}
                        type="button"
                        onClick={() => void pickFromDataset(id)}
                        className="focus-visible:ring-ring overflow-hidden rounded-lg border transition hover:opacity-80 focus-visible:ring-2 focus-visible:outline-none"
                      >
                        {/* Dataset tiles are served from the local ingest cache,
                            so next/image's optimizer adds nothing here. */}
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={roboflowAssetUrl(
                            dataset.slug,
                            roboflowThumbPath(id)
                          )}
                          alt=""
                          loading="lazy"
                          className="aspect-square w-full object-cover"
                        />
                      </button>
                    ))}
                  </div>
                  {shown < ids.length && (
                    <div className="flex justify-center p-4">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setShown((n) => n + PAGE_SIZE)}
                      >
                        Show more ({ids.length - shown} left)
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {error && (
        <p className="text-destructive max-w-xs text-xs">{error}</p>
      )}
    </div>
  )
}
