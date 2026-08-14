# Roboflow dataset mosaic

Give it a [Roboflow Universe](https://universe.roboflow.com) dataset URL and it
renders that dataset as a photo mosaic of itself: every image in the dataset
becomes a tile. What they reassemble into comes from the dataset too — either the
**project's cover image**, or **any single image out of the set**, picked from a
grid.

A fork of [bobdethird/mosaic](https://github.com/bobdethird/mosaic) reduced to
this one page. It keeps that repo's `CanvasHero` interface wholesale — pan/zoom
viewer, hover a tile to see its source image, resolution controls, cached
renders — with two things swapped: where the tiles come from, and how the
reference is chosen. Everything else (the Python/video pipeline, the Supabase
collections and their pages, the gallery, sharing) is gone.

```bash
pnpm install
echo "ROBOFLOW_API_KEY=your_key_here" > .env.local
pnpm dev
# → http://localhost:3000/roboflow
```

The API key is free: roboflow.com → Settings → API Keys. Public Universe
datasets still need one.

The mosaic is built from the **project's source images**, not from a generated
version export. A version in the URL is only cache identity and metadata;
augmentations and generated splits are not included.

### Deploying to Vercel

Connect a public Vercel Blob store to the project before deploying. The ingest
route requires both `ROBOFLOW_API_KEY` and the store-provided
`BLOB_READ_WRITE_TOKEN`: a serverless instance keeps nothing of its own, so each
thumbnail and each library snapshot is written to Blob, and later instances
read those objects back to serve the browser.

Ingests use distributed per-dataset leases, same-origin checks, and a
four-per-15-minute client rate window so one public caller cannot repeatedly
trigger the same expensive job. A separate project-wide window caps aggregate
work from distributed callers.

## How it works

**1. Ingest (server, `lib/roboflow-ingest.ts`).** The URL is parsed into
`workspace / project / version`; a missing version resolves to the project's
latest. Roboflow is asked for the project's images (`POST …/search`,
`in_dataset: true`, pages of 250) and then for each selected image's thumbnail.
One pass per thumbnail produces:

- a **stable id** (sha1 of the Roboflow image id), which de-duplicates the same
  photo if it appears more than once,
- a **16×16×3 colour signature**, packed into the 8×8 uint16 fixed-point format
  the mosaic worker compares on,
- a **thumbnail** (192px long edge), written as soon as it is seeded.

The project's cover image is downloaded alongside them (`project.icon` from the
Roboflow API, capped at 1600px, aspect preserved). Thumbnails are individual
files — locally under `.roboflow-cache/<workspace>--<project>--v<n>/thumbs/`,
and on Vercel as one Blob object each.

After a minimum usable batch, and then every so often as more tiles land, the
ingest publishes an immutable **snapshot** of `manifest.json` and
`signatures-coarse.bin`. The page can open the mosaic from that snapshot while
the job is still running; later batches append. A later failure keeps the last
good snapshot instead of throwing it away.

**2. Generate (browser, unchanged engine + unchanged UI).** The reference is
handed to the existing contour-flow generator: a Sobel edge-vector field, Voronoi
cells pushed out of edges so cell borders settle along contours, one colour
signature per cell, and a min-error tile per cell drawn rotated along the local
contour.

The browser fetches two files up front — the advertised snapshot's manifest and
coarse signature blob — and nothing else. Those are all the generator needs to
choose tiles. Thumbnails are then requested one at a time, by the canvas, hover
preview, zoom view and reference picker, only for tiles actually drawn. Newly
arrived tiles become candidates on the next generation; an already-generated
mosaic is left alone.

**Where the tiles come from** is a `MosaicSource` (`lib/mosaic-source.ts`) —
how the library loads and how a tile's URL is built. Today the only
implementation is `roboflowSource(dataset)`. `CanvasHero` takes a source instead
of a storage backend, so the inherited UI stays source-agnostic. A source holds
functions, so it is built on the client.

**How the reference is chosen** is a `referencePicker` prop. Supplying one
replaces CanvasHero's upload card (and its "replace" control) so there is a
single route to a reference image. The Roboflow picker offers the project cover
and a grid of the dataset's own images, and hands back a `File` — exactly what
the upload card produced, so nothing downstream changes.

Ingests are background work, so the route starts one with Next.js `after()` and
the page polls the ingest route for progress. The first usable snapshot opens
the canvas; polling continues until the job is `ready` or `error`. Local status
is written atomically; Vercel also publishes it to Blob so polls can land on
another function instance. Re-opening a finished dataset version is a cache hit.
To rebuild the tile library from scratch, POST `{"url": …, "refresh": true}` to
the ingest route.

## Storage paths

**Local or persistent Node.** Thumbnails and snapshots are written into
`.roboflow-cache/<workspace>--<project>--v<n>/` as ordinary files. A snapshot
lives under `snapshots/<version>/` and is also copied to the latest
`manifest.json` / `signatures-coarse.bin` pointers.

**Vercel.** The same layout is one Blob object per file. The asset route reads
a single object; no instance ever downloads a library archive.

**Choosing tiles.** What caps a build is what the mosaic can draw, not what the
host can hold: the frame is 1600px and the finest cell is 8px, so past ~20,000
tiles the extra ones are images the ingest re-encodes for nothing. A project
with more images than that is sampled evenly across the whole set rather than
truncated at the front, and when the deadline is the tighter constraint the
sample shrinks to what can be fetched and decoded in the time left. A build that
runs out of time publishes the tiles it has instead of failing, and the page
says when a mosaic is drawn from a sample.

## Layout

| Path                                       | What                                                  |
| ------------------------------------------ | ----------------------------------------------------- |
| `app/roboflow/`                            | the page                                              |
| `components/roboflow-mosaic.tsx`           | URL input → ingest → hand off to CanvasHero           |
| `components/roboflow-reference-picker.tsx` | project cover, or a grid of the dataset               |
| `lib/mosaic-source.ts`                     | where tiles come from (Roboflow)                      |
| `lib/roboflow.ts`                          | URL parsing, slugs, asset URLs (shared client/server) |
| `lib/roboflow-api.ts`                      | Roboflow project, search, and image REST calls        |
| `lib/roboflow-ingest.ts`                   | thumbnail fetch, signature build, snapshot publish    |
| `lib/zip-format.ts`                        | zip format primitives                                 |
| `lib/zip-index.ts`                         | named-entry reader over a zip                         |
| `lib/roboflow-sink.ts`                     | where seeded files go (Blob objects, or a dir)        |
| `lib/roboflow-store.ts`                    | local cache, status, job registry                     |
| `lib/roboflow-blob.ts`                     | durable status, snapshot keys, individual file reads  |
| `lib/roboflow-control.ts`                  | distributed leases and public-ingest rate limits      |
| `lib/roboflow-limits.ts`                   | shared server and browser resource ceilings           |
| `lib/roboflow-pack.ts`                     | the browser's manifest and signature load             |
| `app/api/roboflow/ingest/`                 | start (POST) / poll (GET) an ingest                   |
| `app/api/roboflow/asset/[slug]/[...path]/` | one file: from the cache dir, or from Blob            |
| `lib/mosaic*.ts`, `lib/contour-mosaic.ts`  | the inherited engine                                  |
| `components/canvas-hero.tsx`               | the inherited UI, now source-agnostic                 |
| `lib/tile-library.ts`                      | the shared tile/signature shapes                      |

## Any folder of images

The tile-library half of the pipeline doesn't care where the images came from:

```bash
pnpm ingest:dir ~/Pictures/some-folder myworkspace my-project 1
# → then enter  myworkspace/my-project/1  on /roboflow
```

This is also how to exercise the pipeline without an API key.

## What was removed

The inherited pages (`/knicks-mosaic`, `/newyork-mosaic`, `/bake`, `/m/<id>`,
`/admin`, the landing page and gallery) and everything only they used — the
Supabase proxy, share/publish flow, submission routes, auth/admin helpers,
era-emphasis matching, and baked gallery assets — are deleted. `/` redirects to
`/roboflow`. Local development only needs `ROBOFLOW_API_KEY`; Vercel also needs
the connected Blob store described above.
