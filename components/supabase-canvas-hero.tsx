"use client"

// CanvasHero for a Supabase collection.
//
// A `MosaicSource` holds functions, which a server component cannot hand to a
// client component — so the source has to be built on the client. This wrapper
// takes the serializable bucket name and does that, letting the Supabase pages
// stay server components.

import * as React from "react"

import { CanvasHero } from "@/components/canvas-hero"
import { supabaseSource } from "@/lib/mosaic-source"
import type { MosaicBucket } from "@/lib/photo-library"

type Props = Omit<
  React.ComponentProps<typeof CanvasHero>,
  "collection" | "referencePicker"
> & {
  bucket: MosaicBucket
}

export function SupabaseCanvasHero({ bucket, ...rest }: Props) {
  // Stable across renders: CanvasHero uses it as an effect dependency.
  const collection = React.useMemo(() => supabaseSource(bucket), [bucket])
  return <CanvasHero collection={collection} {...rest} />
}
