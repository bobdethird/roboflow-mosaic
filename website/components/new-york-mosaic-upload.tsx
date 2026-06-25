"use client"

import * as React from "react"
import { ArrowRight, ImagePlus, Loader2, X } from "lucide-react"
import { track } from "@vercel/analytics"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
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
  NEW_YORK_MOSAIC_MAX_FILES,
  NEW_YORK_MOSAIC_MAX_IMAGE_BYTES,
  NEW_YORK_MOSAIC_UPLOAD_ENDPOINT,
  NEW_YORK_MOSAIC_UPLOAD_OPENED_EVENT,
  NEW_YORK_MOSAIC_UPLOAD_SUBMITTED_EVENT,
  type NewYorkMosaicFormSource,
} from "@/lib/new-york-mosaic"

type Selected = {
  // Stable key so previews don't flicker when the list changes.
  key: string
  file: File
  previewUrl: string
}

type Status = "idle" | "submitting" | "success"

function makeKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}:${Math.random()
    .toString(36)
    .slice(2)}`
}

export function NewYorkMosaicUpload({
  source,
  children,
}: {
  source: NewYorkMosaicFormSource
  children: React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  const [selected, setSelected] = React.useState<Selected[]>([])
  const [wantCredit, setWantCredit] = React.useState<boolean | null>(null)
  const [name, setName] = React.useState("")
  const [status, setStatus] = React.useState<Status>("idle")
  const [error, setError] = React.useState<string | null>(null)
  const [dragging, setDragging] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  // Nested dragenter/dragleave fire per child element; count depth so the
  // highlight only clears when the cursor actually leaves the drop zone.
  const dragDepth = React.useRef(0)

  // Revoke object URLs on unmount / when the list is replaced.
  React.useEffect(() => {
    return () => {
      selected.forEach((s) => URL.revokeObjectURL(s.previewUrl))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function resetForm() {
    setSelected((prev) => {
      prev.forEach((s) => URL.revokeObjectURL(s.previewUrl))
      return []
    })
    setWantCredit(null)
    setName("")
    setStatus("idle")
    setError(null)
    setDragging(false)
    dragDepth.current = 0
  }

  function handleOpenChange(next: boolean) {
    setOpen(next)
    if (next) {
      track(NEW_YORK_MOSAIC_UPLOAD_OPENED_EVENT, { source })
    } else {
      // Reset shortly after the close animation so it doesn't flash empty.
      setTimeout(resetForm, 200)
    }
  }

  function addFiles(fileList: FileList | null) {
    if (!fileList || fileList.length === 0) return

    // Build the accepted list here, OUTSIDE the state updater, so this runs
    // exactly once. (A setState updater must be pure — React invokes it twice
    // in dev StrictMode — so creating object URLs / pushing in there double-adds.)
    const incoming = Array.from(fileList)
    const remaining = NEW_YORK_MOSAIC_MAX_FILES - selected.length
    if (remaining <= 0) {
      setError(`You can upload up to ${NEW_YORK_MOSAIC_MAX_FILES} photos.`)
      return
    }

    const accepted: Selected[] = []
    let rejectedSize = false
    for (const file of incoming) {
      if (accepted.length >= remaining) break
      if (!file.type.startsWith("image/")) continue
      if (file.size > NEW_YORK_MOSAIC_MAX_IMAGE_BYTES) {
        rejectedSize = true
        continue
      }
      accepted.push({
        key: makeKey(file),
        file,
        previewUrl: URL.createObjectURL(file),
      })
    }

    if (incoming.length > remaining) {
      setError(`You can upload up to ${NEW_YORK_MOSAIC_MAX_FILES} photos.`)
    } else if (rejectedSize) {
      setError(
        `Each photo must be ${
          NEW_YORK_MOSAIC_MAX_IMAGE_BYTES / (1024 * 1024)
        } MB or smaller.`
      )
    } else {
      setError(null)
    }

    if (accepted.length > 0) {
      setSelected((prev) => [...prev, ...accepted])
    }

    // Allow re-selecting the same file later.
    if (inputRef.current) inputRef.current.value = ""
  }

  function removeFile(key: string) {
    setSelected((prev) => {
      const found = prev.find((s) => s.key === key)
      if (found) URL.revokeObjectURL(found.previewUrl)
      return prev.filter((s) => s.key !== key)
    })
  }

  function handleDragEnter(event: React.DragEvent) {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return
    event.preventDefault()
    dragDepth.current += 1
    setDragging(true)
  }

  function handleDragOver(event: React.DragEvent) {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
  }

  function handleDragLeave() {
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragging(false)
  }

  function handleDrop(event: React.DragEvent) {
    event.preventDefault()
    dragDepth.current = 0
    setDragging(false)
    addFiles(event.dataTransfer.files)
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (selected.length === 0) {
      setError("Add at least one photo.")
      return
    }

    setStatus("submitting")
    setError(null)

    const form = new FormData()
    selected.forEach((s) => form.append("photos", s.file, s.file.name))
    if (wantCredit && name.trim()) {
      form.append("creditName", name.trim())
    }

    try {
      const res = await fetch(NEW_YORK_MOSAIC_UPLOAD_ENDPOINT, {
        method: "POST",
        body: form,
      })
      if (!res.ok) {
        let message = "Something went wrong. Please try again."
        try {
          const data = (await res.json()) as { error?: string }
          if (data?.error) message = data.error
        } catch {
          // keep the default
        }
        setError(message)
        setStatus("idle")
        return
      }
      track(NEW_YORK_MOSAIC_UPLOAD_SUBMITTED_EVENT, {
        source,
        count: selected.length,
        credited: Boolean(wantCredit && name.trim()),
      })
      setStatus("success")
    } catch {
      setError("Couldn't reach the server. Please check your connection.")
      setStatus("idle")
    }
  }

  const submitting = status === "submitting"
  const canAddMore = selected.length < NEW_YORK_MOSAIC_MAX_FILES

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="gap-0 p-6 font-sans sm:max-w-lg sm:p-8">
        {status === "success" ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <DialogTitle className="text-lg">Thank you!</DialogTitle>
            <DialogDescription className="text-pretty">
              Your {selected.length === 1 ? "photo" : "photos"} are in. We review
              every submission before it joins the mosaic of New York.
            </DialogDescription>
            <Button
              type="button"
              className="mt-2 rounded-none"
              onClick={() => handleOpenChange(false)}
            >
              Done
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-6">
            <DialogHeader className="items-center px-6 text-center">
              <DialogTitle className="text-xl text-balance">
                Upload photos of what represents NYC to you
              </DialogTitle>
              <DialogDescription className="text-pretty">
                {`Share up to ${NEW_YORK_MOSAIC_MAX_FILES} photos. They'll be reviewed before joining the mosaic.`}
              </DialogDescription>
            </DialogHeader>

            {/* Photo picker + previews (also a drag-and-drop target) */}
            <div className="flex flex-col items-center gap-3">
              <div
                onDragEnter={handleDragEnter}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={cn(
                  "relative flex w-full flex-wrap justify-center gap-2 rounded-xl border-2 border-dashed p-4 transition-colors",
                  dragging ? "border-foreground bg-muted/40" : "border-transparent"
                )}
              >
                {selected.map((s) => (
                  <div
                    key={s.key}
                    className="group relative size-24 overflow-hidden rounded-lg border"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- local object URL preview */}
                    <img
                      src={s.previewUrl}
                      alt={s.file.name}
                      className="h-full w-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={() => removeFile(s.key)}
                      aria-label={`Remove ${s.file.name}`}
                      className="absolute top-1 right-1 inline-flex size-5 items-center justify-center rounded-full bg-black/60 text-white transition-opacity hover:bg-black/80"
                    >
                      <X className="size-3" />
                    </button>
                  </div>
                ))}

                {canAddMore && (
                  <button
                    type="button"
                    onClick={() => inputRef.current?.click()}
                    className="flex size-24 flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
                  >
                    <ImagePlus className="size-5" />
                    <span className="text-xs">Add</span>
                  </button>
                )}

                {dragging && (
                  <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-background/85 text-sm font-medium text-foreground">
                    Drop photos to add
                  </div>
                )}
              </div>

              <input
                ref={inputRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(e) => addFiles(e.target.files)}
              />

              <p className="text-xs text-muted-foreground">
                Drag &amp; drop or click to add · {selected.length}/
                {NEW_YORK_MOSAIC_MAX_FILES} selected
              </p>
            </div>

            {/* Credit opt-in */}
            <div className="flex flex-col items-center gap-3">
              <p className="text-center text-sm font-medium text-foreground">
                Would you like to be credited for your photos?
              </p>
              <div className="flex justify-center gap-2">
                <Button
                  type="button"
                  variant={wantCredit === true ? "default" : "outline"}
                  size="sm"
                  className="rounded-none"
                  onClick={() => setWantCredit(true)}
                >
                  Yes
                </Button>
                <Button
                  type="button"
                  variant={wantCredit === false ? "default" : "outline"}
                  size="sm"
                  className="rounded-none"
                  onClick={() => {
                    setWantCredit(false)
                    setName("")
                  }}
                >
                  No
                </Button>
              </div>

              <div
                className={cn(
                  "grid w-full transition-all duration-200",
                  wantCredit === true
                    ? "grid-rows-[1fr] opacity-100"
                    : "grid-rows-[0fr] opacity-0"
                )}
              >
                <div className="overflow-hidden px-px">
                  <Input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="First and last name (optional)"
                    maxLength={120}
                    className="mt-1 h-10 rounded-none text-center"
                  />
                </div>
              </div>
            </div>

            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}

            <Button
              type="submit"
              disabled={submitting || selected.length === 0}
              className="h-10 rounded-none"
            >
              {submitting ? (
                <>
                  <Loader2 className="animate-spin" />
                  Uploading…
                </>
              ) : (
                <>
                  Submit
                  <ArrowRight />
                </>
              )}
            </Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
