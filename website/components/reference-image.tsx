"use client"

import * as React from "react"
import { ImageUp } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

export type ReferenceImage = {
  url: string
  name: string
  width: number
  height: number
}

// Load a file into a reference image, reading its natural dimensions so callers
// can letterbox/fit it. Creates a session-scoped object URL; the caller owns
// revoking it (on replace/remove/unmount) to avoid leaks.
export function makeReferenceFromFile(file: File): Promise<ReferenceImage> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () =>
      resolve({
        url,
        name: file.name,
        width: img.naturalWidth,
        height: img.naturalHeight,
      })
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error("Could not read image"))
    }
    img.src = url
  })
}

function firstImage(files: FileList | null): File | null {
  if (!files) return null
  for (const file of Array.from(files)) {
    if (file.type.startsWith("image/")) return file
  }
  return null
}

interface ReferenceEmptyCardProps {
  onSelect: (file: File) => void
}

// Compact empty-state card. Click to browse or drop an image onto it (pasting
// also works, handled by the canvas). No forced full-screen prompt.
export function ReferenceEmptyCard({ onSelect }: ReferenceEmptyCardProps) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = React.useState(false)
  // dragenter/leave fire for every child; a depth counter keeps the highlight
  // stable until the pointer actually leaves the card.
  const dragDepth = React.useRef(0)

  return (
    <div data-no-pan>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragEnter={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return
          e.preventDefault()
          dragDepth.current++
          setIsDragOver(true)
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault()
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setIsDragOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          dragDepth.current = 0
          setIsDragOver(false)
          const file = firstImage(e.dataTransfer.files)
          if (file) onSelect(file)
        }}
        aria-label="Add reference image"
        className={cn(
          "flex aspect-square w-[28rem] max-w-[86vw] flex-col items-center justify-center rounded-2xl border border-dashed p-8 text-center",
          "hover:bg-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30",
          isDragOver && "border-primary bg-accent"
        )}
      >
        <span className="grid size-12 place-items-center rounded-full bg-muted text-muted-foreground">
          <ImageUp className="size-5" />
        </span>
        <span className="text-lg text-muted-foreground">
          Add a reference image to begin
        </span>
        <span className="text-sm text-muted-foreground">click, drop, or paste</span>
      </button>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = firstImage(e.target.files)
          if (file) onSelect(file)
          e.target.value = ""
        }}
      />
    </div>
  )
}

interface ReferencePanelEmptyProps {
  onSelect: (file: File) => void
}

// Compact empty state for the sidebar reference panel.
export function ReferencePanelEmpty({ onSelect }: ReferencePanelEmptyProps) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  const [isDragOver, setIsDragOver] = React.useState(false)
  const dragDepth = React.useRef(0)

  return (
    <div data-no-pan>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragEnter={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return
          e.preventDefault()
          dragDepth.current++
          setIsDragOver(true)
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes("Files")) e.preventDefault()
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1)
          if (dragDepth.current === 0) setIsDragOver(false)
        }}
        onDrop={(e) => {
          e.preventDefault()
          dragDepth.current = 0
          setIsDragOver(false)
          const file = firstImage(e.dataTransfer.files)
          if (file) onSelect(file)
        }}
        aria-label="Add reference image"
        className={cn(
          "flex w-full flex-col items-center gap-2 rounded-xl border border-dashed p-4 text-center",
          "hover:bg-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30",
          isDragOver && "border-primary bg-accent"
        )}
      >
        <span className="grid size-10 place-items-center rounded-full bg-muted text-muted-foreground">
          <ImageUp className="size-4" />
        </span>
        <span className="text-sm text-muted-foreground">Add a reference image</span>
        <span className="text-xs text-muted-foreground">click, drop, or paste</span>
      </button>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = firstImage(e.target.files)
          if (file) onSelect(file)
          e.target.value = ""
        }}
      />
    </div>
  )
}

interface ReferenceCardProps {
  reference: ReferenceImage
  onReplace: (file: File) => void
  onRemove: () => void
}

// Persistent home for the active reference: thumbnail + filename + actions.
export function ReferenceCard({
  reference,
  onReplace,
  onRemove,
}: ReferenceCardProps) {
  const inputRef = React.useRef<HTMLInputElement>(null)
  return (
    <div data-no-pan className="flex w-full items-start gap-3">
      <div className="size-14 shrink-0 overflow-hidden rounded-md bg-muted">
        {/* eslint-disable-next-line @next/next/no-img-element -- object URL, no next/image benefit */}
        <img
          src={reference.url}
          alt={reference.name}
          className="size-full object-cover"
          draggable={false}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-sm font-medium" title={reference.name}>
          {reference.name}
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="link"
            size="xs"
            className="h-auto p-0"
            onClick={() => inputRef.current?.click()}
          >
            replace
          </Button>
          <Separator
            orientation="vertical"
            className="h-3 data-vertical:self-center"
          />
          <Button
            variant="link"
            size="xs"
            className="h-auto p-0"
            onClick={onRemove}
          >
            remove
          </Button>
        </div>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = firstImage(e.target.files)
          if (file) onReplace(file)
          e.target.value = ""
        }}
      />
    </div>
  )
}
