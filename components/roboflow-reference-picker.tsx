"use client"

// Chooses what a Roboflow dataset's mosaic reproduces. Two sources, both from
// the dataset itself:
//
//   Project cover — the image the dataset's author picked to represent it.
//   From dataset  — any single image in the set, chosen from a grid.
//
// Either way the result is handed back as a `File`, which is exactly what
// CanvasHero's upload card produces, so nothing downstream changes.
//
// Both come out of the downloaded library archive, which the canvas is loading
// anyway — this takes a reference on the same copy rather than fetching again.

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
import { type RoboflowDataset } from "@/lib/roboflow"
import { acquirePack, releasePack, type RoboflowPack } from "@/lib/roboflow-pack"

// How many thumbnails to put in the grid at once. The images are local by now,
// but a dataset runs to thousands of them and mounting every <img> at once
// still costs layout and decode work.
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
  const [pack, setPack] = React.useState<RoboflowPack | null>(null)
  const [shown, setShown] = React.useState(PAGE_SIZE)

  const { slug, libraryVersion, imageCount, hasIcon } = dataset

  React.useEffect(() => {
    let cancelled = false
    void acquirePack(slug, {
      expectedVersion: libraryVersion ?? null,
      expectedPhotoCount: imageCount,
      hasIcon,
    }).then(
      (loaded) => {
        if (!cancelled) setPack(loaded)
      },
      (loadError: unknown) => {
        if (cancelled) return
        setError(
          loadError instanceof Error
            ? loadError.message
            : "Could not load the dataset's images."
        )
      }
    )
    return () => {
      cancelled = true
      releasePack(slug)
    }
  }, [slug, libraryVersion, imageCount, hasIcon])

  const ids = React.useMemo(
    () => pack?.manifest.photos.map((photo) => photo.id) ?? null,
    [pack]
  )

  const chooseCover = React.useCallback(async () => {
    setError(null)
    setBusy("cover")
    try {
      if (!pack?.iconUrl) {
        throw new Error(
          "This dataset has no cover image. Pick an image from the dataset instead."
        )
      }
      onSelect(await urlToFile(pack.iconUrl, `${dataset.project}-cover.jpg`))
    } catch (coverError) {
      setError(
        coverError instanceof Error
          ? coverError.message
          : "Could not use the project cover."
      )
    } finally {
      setBusy(null)
    }
  }, [dataset.project, onSelect, pack])

  const openGrid = React.useCallback(() => {
    setError(null)
    setOpen(true)
  }, [])

  const pickFromDataset = React.useCallback(
    async (id: string) => {
      setError(null)
      setOpen(false)
      try {
        const url = pack?.thumbUrl(id)
        if (!url) throw new Error("That image is not in the dataset archive.")
        onSelect(await urlToFile(url, `${dataset.project}-${id}.jpg`))
      } catch (pickError) {
        setError(
          pickError instanceof Error
            ? pickError.message
            : "Could not use that image."
        )
      }
    },
    [dataset.project, onSelect, pack]
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
              onClick={openGrid}
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
                    {ids.slice(0, shown).map((id) => {
                      const src = pack?.thumbUrl(id)
                      if (!src) return null
                      return (
                        <button
                          key={id}
                          type="button"
                          onClick={() => void pickFromDataset(id)}
                          className="focus-visible:ring-ring overflow-hidden rounded-lg border transition hover:opacity-80 focus-visible:ring-2 focus-visible:outline-none"
                        >
                          {/* Already a dataset-sized thumbnail, so there is
                              nothing for next/image's optimizer to do. Native
                              lazy loading means scrolling the grid is what
                              fetches these, a page at a time. */}
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={src}
                            alt=""
                            loading="lazy"
                            className="aspect-square w-full object-cover"
                          />
                        </button>
                      )
                    })}
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
