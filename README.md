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

### Deploying to Vercel

Connect a public Vercel Blob store to the project before deploying. The ingest
route requires both `ROBOFLOW_API_KEY` and the store-provided
`BLOB_READ_WRITE_TOKEN`: Vercel's `/tmp` filesystem is only scratch space and is
deleted after each finished or failed ingest. The completed library is streamed
to Blob and the browser downloads it from the Blob CDN.

To stay below the function's 500 MB scratch-space ceiling, deployments accept
exports up to 320 MB and generated libraries up to 128 MB. Larger datasets fail
with a size-limit message instead of filling the filesystem. Ingests use
distributed per-dataset leases, same-origin checks, and a four-per-15-minute
client rate window so one public caller cannot repeatedly trigger the same
expensive export. A separate project-wide window caps aggregate work from
distributed callers.

## How it works

**1. Ingest (server, `lib/roboflow-ingest.ts`).** The URL is parsed into
`workspace / project / version`; a missing version resolves to the project's
latest. Roboflow is asked for a zip export (the format is chosen from the project
type, falling back through the others — every format ships the same images, only
the annotation sidecars differ). Images are decoded directly from that zip, so
the full-resolution originals are not extracted to disk. One pass produces:

- a **content-addressed id** (sha1 of the bytes), which also de-duplicates the
  augmented copies that Roboflow exports across splits,
- a **16×16×3 colour signature**, packed into the 8×8 uint16 fixed-point format
  the mosaic worker compares on,
- a **thumbnail** (192px long edge).

The project's cover image is downloaded alongside them (`project.icon` from the
Roboflow API, capped at 1600px, aspect preserved). Locally, results remain in
`.roboflow-cache/<workspace>--<project>--v<n>/`. On Vercel, the library is
streamed as one zip to Blob and the temporary build directory is deleted.

**2. Generate (browser, unchanged engine + unchanged UI).** The reference is
handed to the existing contour-flow generator: a Sobel edge-vector field, Voronoi
cells pushed out of edges so cell borders settle along contours, one colour
signature per cell, and a min-error tile per cell drawn rotated along the local
contour.

The browser downloads the dataset archive once, unpacks it into object URLs, and
caches the archive in IndexedDB. The canvas, hover preview, zoom view, and
reference picker then share that one in-browser copy instead of making one HTTP
request per thumbnail. ZIP parsing is incremental and capped at 128 MB, so a
malformed or unexpectedly large pack cannot grow browser memory without bound.

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

Ingests are slow, so the route starts one with Next.js `after()` and the page
polls the ingest route for progress. Local status is written atomically; Vercel
also publishes it to Blob so polls can land on another function instance.
Re-opening a published dataset version is a cache hit. To rebuild one from
scratch, POST `{"url": …, "refresh": true}` to the ingest route.

## Layout

| Path                                       | What                                                   |
| ------------------------------------------ | ------------------------------------------------------ |
| `app/roboflow/`                            | the page                                               |
| `components/roboflow-mosaic.tsx`           | URL input → ingest → hand off to CanvasHero            |
| `components/roboflow-reference-picker.tsx` | project cover, or a grid of the dataset                |
| `lib/mosaic-source.ts`                     | where tiles come from (Roboflow)                       |
| `lib/roboflow.ts`                          | URL parsing, slugs, asset URLs (shared client/server)  |
| `lib/roboflow-api.ts`                      | the two Roboflow REST calls                            |
| `lib/roboflow-ingest.ts`                   | export download, thumbnail and signature build         |
| `lib/roboflow-store.ts`                    | local cache, scratch directories, status, job registry |
| `lib/roboflow-blob.ts`                     | durable status and streamed archive publication        |
| `lib/roboflow-control.ts`                  | distributed leases and public-ingest rate limits       |
| `lib/roboflow-limits.ts`                   | shared server and browser resource ceilings            |
| `lib/roboflow-pack.ts`                     | browser download, unzip, and IndexedDB cache           |
| `app/api/roboflow/ingest/`                 | start (POST) / poll (GET) an ingest                    |
| `app/api/roboflow/pack/[slug]/`            | Blob redirect or local streamed archive                |
| `lib/mosaic*.ts`, `lib/contour-mosaic.ts`  | the inherited engine, untouched                        |
| `components/canvas-hero.tsx`               | the inherited UI, now source-agnostic                  |
| `lib/tile-library.ts`                      | the shared tile/signature shapes                       |

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
