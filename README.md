# Roboflow dataset mosaic

Give it a [Roboflow Universe](https://universe.roboflow.com) dataset URL and it
renders that dataset as a photo mosaic of itself: every image in the dataset
becomes a tile. What they reassemble into comes from the dataset too — either the
**project's cover image**, or **any single image out of the set**, picked from a
grid.

A fork of [bobdethird/mosaic](https://github.com/bobdethird/mosaic), keeping only
the website (that repo's `website/`, hoisted to the root here) and dropping the
Python/video pipeline. `/roboflow` runs the *same* `CanvasHero` UI as
`/knicks-mosaic` — pan/zoom viewer, hover a tile to see its source image,
resolution controls, cached renders — with two things swapped: where the tiles
come from, and how the reference is chosen.

```bash
pnpm install
echo "ROBOFLOW_API_KEY=your_key_here" > .env.local
pnpm dev
# → http://localhost:3000/roboflow
```

The API key is free: roboflow.com → Settings → API Keys. Public Universe
datasets still need one.

## How it works

**1. Ingest (server, `lib/roboflow-ingest.ts`).** The URL is parsed into
`workspace / project / version`; a missing version resolves to the project's
latest. Roboflow is asked for a zip export (the format is chosen from the project
type, falling back through the others — every format ships the same images, only
the annotation sidecars differ), the zip is streamed down, and its images are
extracted. Then one pass per image produces:

- a **content-addressed id** (sha1 of the bytes), which also de-duplicates the
  augmented copies that Roboflow exports across splits,
- a **16×16×3 colour signature**, packed into the 8×8 uint16 fixed-point format
  the mosaic worker compares on,
- a **thumbnail** (384px long edge), and
- a contribution to the **median image**.

The project's cover image is downloaded alongside them (`project.icon` from the
Roboflow API, capped at 1600px, aspect preserved). A project without one — or a
local-folder ingest — just leaves the median as the only reference.

Results land in `.roboflow-cache/<workspace>--<project>--v<n>/`, laid out exactly
like the Supabase buckets the original engine reads (`manifest.json`,
`signatures-coarse.bin`, `thumbs/<id>.jpg`), plus the two references:
`reference.jpg` (the median) and `icon.jpg` (the cover).

**The median.** Still computed and written as `reference.jpg`, though the UI no
longer offers it — the reference is the cover or an image from the set. Every
sampled image is folded into a per-pixel, per-channel value
histogram, so the median runs over the whole dataset without ever holding it in
memory. A median rather than a mean because the mean smears outliers into every
pixel; the median keeps whatever structure the dataset actually shares — the
framing, the background, the object that sits in the middle of every shot.

Nothing is cropped out of the reference. The frame is the dataset's **own native
size** (the size most of its images share, or the median width and height for a
mixed set), and each image is resampled whole into it — so for the usual
uniformly-sized export the map is 1:1 and no resampling happens at all. The only
thing that can shrink the frame is the histogram's memory ceiling
(width × height × 3 × 256 × 2 bytes, capped around a 512×512-equivalent), and
that preserves the aspect ratio.

**2. Generate (browser, unchanged engine + unchanged UI).** The reference is
handed to the existing contour-flow generator: a Sobel edge-vector field, Voronoi
cells pushed out of edges so cell borders settle along contours, one colour
signature per cell, and a min-error tile per cell drawn rotated along the local
contour. Tiles are fetched lazily, one thumbnail per placed cell.

**Where the tiles come from** is now an argument. `lib/mosaic-source.ts` defines
a `MosaicSource` — how the library loads, how a tile's URL is built, whether the
result can be published — with `supabaseSource(bucket)` and
`roboflowSource(dataset)` behind it. `CanvasHero` used to take a bucket name and
call Supabase directly; it takes a source instead, so one UI serves both. A
source holds functions, so it has to be built on the client: server pages go
through `SupabaseCanvasHero`.

**How the reference is chosen** is a `referencePicker` prop. Supplying one
replaces CanvasHero's upload card (and its "replace" control) so there is a
single route to a reference image. The Roboflow picker offers the project cover
and a grid of the dataset's own images, and hands back a `File` — exactly what
the upload card produced, so nothing downstream changes.

Ingests are slow (a large export is hundreds of megabytes), so the route starts
one in the background and the page polls `status.json` for progress. Re-opening a
dataset whose version is named in the URL is a pure cache hit — no API call.

Picking **Project cover** for a dataset with none saved (one ingested before
covers were fetched) pulls just that image via `/api/roboflow/cover` — no
re-export. To rebuild a dataset from scratch, POST
`{"url": …, "refresh": true}` to the ingest route.

## Layout

| Path | What |
| --- | --- |
| `app/roboflow/` | the page |
| `components/roboflow-mosaic.tsx` | URL input → ingest → hand off to CanvasHero |
| `components/roboflow-reference-picker.tsx` | project cover, or a grid of the dataset |
| `lib/mosaic-source.ts` | where tiles come from (Supabase or Roboflow) |
| `components/supabase-canvas-hero.tsx` | client wrapper for the Supabase pages |
| `lib/roboflow.ts` | URL parsing, slugs, asset URLs (shared client/server) |
| `lib/roboflow-api.ts` | the two Roboflow REST calls |
| `lib/roboflow-ingest.ts` | download, extract, tiles, signatures, median |
| `lib/roboflow-store.ts` | cache layout, ingest status, job registry |
| `lib/roboflow-library.ts` | browser-side library loader |
| `app/api/roboflow/ingest/` | start (POST) / poll (GET) an ingest |
| `app/api/roboflow/cover/` | fetches a project cover into an existing dataset |
| `app/api/roboflow/asset/` | serves one dataset's cached library files |
| `lib/mosaic*.ts`, `lib/contour-mosaic.ts` | the inherited engine, untouched |
| `components/canvas-hero.tsx` | the inherited UI, now source-agnostic |

## Any folder of images

The tile/median half of the pipeline doesn't care where the images came from:

```bash
pnpm ingest:dir ~/Pictures/some-folder myworkspace my-project 1
# → then enter  myworkspace/my-project/1  on /roboflow
```

This is also how to exercise the pipeline without an API key.

## Inherited pages

The original site's pages (`/`, `/knicks-mosaic`, `/newyork-mosaic`, `/mosaic`,
`/bake`) came along with the engine and still expect Supabase credentials
(`NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SECRET_KEY`). Without them, only
`/roboflow` works — it reads from the local cache instead.
