# Roboflow dataset mosaic

Give it a [Roboflow Universe](https://universe.roboflow.com) dataset URL and it
renders that dataset as a photo mosaic of **its own median image**: every tile is
one image from the dataset, and the picture they reassemble into is the
per-pixel median of the whole set — the shape the dataset agrees on.

A fork of [bobdethird/mosaic](https://github.com/bobdethird/mosaic), keeping only
the in-browser mosaic engine (that repo's `website/`, hoisted to the root here)
and dropping the Python/video pipeline.

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

Results land in `.roboflow-cache/<workspace>--<project>--v<n>/`, laid out exactly
like the Supabase buckets the original engine reads (`manifest.json`,
`signatures-coarse.bin`, `thumbs/<id>.jpg`), plus `reference.jpg` — the median.

**The median.** Every sampled image is cover-fitted to a common frame and folded
into a per-pixel, per-channel value histogram, so the median runs over the whole
dataset without ever holding it in memory. A median rather than a mean because
the mean smears outliers into every pixel; the median keeps whatever structure
the dataset actually shares — the framing, the background, the object that sits
in the middle of every shot.

**2. Generate (browser, unchanged engine).** The median image is handed to the
existing contour-flow generator: a Sobel edge-vector field, Voronoi cells pushed
out of edges so cell borders settle along contours, one colour signature per
cell, and a min-error tile per cell drawn rotated along the local contour. Tiles
are fetched lazily, one thumbnail per placed cell.

Ingests are slow (a large export is hundreds of megabytes), so the route starts
one in the background and the page polls `status.json` for progress. Re-opening a
dataset whose version is named in the URL is a pure cache hit — no API call.

## Layout

| Path | What |
| --- | --- |
| `app/roboflow/` | the page |
| `components/roboflow-mosaic.tsx` | URL input → ingest → generate → canvas |
| `lib/roboflow.ts` | URL parsing, slugs, asset URLs (shared client/server) |
| `lib/roboflow-api.ts` | the two Roboflow REST calls |
| `lib/roboflow-ingest.ts` | download, extract, tiles, signatures, median |
| `lib/roboflow-store.ts` | cache layout, ingest status, job registry |
| `lib/roboflow-library.ts` | browser-side library loader |
| `app/api/roboflow/ingest/` | start (POST) / poll (GET) an ingest |
| `app/api/roboflow/asset/` | serves one dataset's cached library files |
| `lib/mosaic*.ts`, `lib/contour-mosaic.ts` | the inherited engine, untouched |

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
