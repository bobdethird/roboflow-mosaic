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
`BLOB_READ_WRITE_TOKEN`: a serverless instance keeps nothing of its own, so the
library it builds is streamed to Blob, and later instances read single files back
out of it to serve the browser.

Datasets of any size are accepted, and the size of one does not decide whether it
works. Nothing is staged on the function's ~500 MB `/tmp`: the export is read
over HTTP and the library is uploaded as it is built, so peak disk is zero and
peak memory is one 8 MB upload part regardless of how large the export is (see
"Datasets of any size" below). Ingests use distributed per-dataset leases,
same-origin checks, and a four-per-15-minute client rate window so one public
caller cannot repeatedly trigger the same expensive export. A separate
project-wide window caps aggregate work from distributed callers.

## How it works

**1. Ingest (server, `lib/roboflow-ingest.ts`).** The URL is parsed into
`workspace / project / version`; a missing version resolves to the project's
latest. Roboflow is asked for a zip export (the format is chosen from the project
type, falling back through the others — every format ships the same images, only
the annotation sidecars differ). That zip is never downloaded as a file: its
entries are read out of the remote archive over HTTP and decoded in memory
(`lib/roboflow-zip.ts`). One pass per image produces:

- a **content-addressed id** (sha1 of the bytes), which also de-duplicates the
  augmented copies that Roboflow exports across splits,
- a **16×16×3 colour signature**, packed into the 8×8 uint16 fixed-point format
  the mosaic worker compares on,
- a **thumbnail** (192px long edge).

The project's cover image is downloaded alongside them (`project.icon` from the
Roboflow API, capped at 1600px, aspect preserved). Where the finished tiles go is
a `LibrarySink` (`lib/roboflow-sink.ts`): locally they are written into
`.roboflow-cache/<workspace>--<project>--v<n>/`, and on Vercel they are zipped
and pushed to Blob as they are produced, so no build directory exists to clean up.

**2. Generate (browser, unchanged engine + unchanged UI).** The reference is
handed to the existing contour-flow generator: a Sobel edge-vector field, Voronoi
cells pushed out of edges so cell borders settle along contours, one colour
signature per cell, and a min-error tile per cell drawn rotated along the local
contour.

The browser fetches two files up front — the manifest and the coarse signature
blob — and nothing else. Those are all the generator needs to choose tiles, and
they are small enough to arrive in well under a second even for a 100,000-image
dataset. Thumbnails are then requested one at a time, by the canvas, hover
preview, zoom view and reference picker, only for tiles actually drawn: a mosaic
paints a few thousand of them, so a dataset an order of magnitude larger costs
nothing extra to open. Each thumbnail is named for the hash of its bytes and
served `immutable`, so it is fetched once and thereafter comes from the HTTP
cache.

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

## Datasets of any size

A Vercel function has ~500 MB of `/tmp` and a five-minute ceiling. Roboflow
exports are not bounded by either, so neither end of the ingest touches a
filesystem and neither holds more than a working set.

**Reading the export.** A zip's index (its central directory) sits at the end of
the file, so two range requests are enough to learn every image entry's name,
offset and size before an image byte moves (`readZipIndex`). The ingest can then
fetch precisely the entries it wants — nearby ones coalesced into shared ranged
reads — instead of the whole archive. A host that ignores `Range` falls back to
one sequential pass that keeps what it needs and discards the rest as it goes
past. Either way the peak is one read window, not one export.

**Writing the library.** The library is produced as a stream: each thumbnail is
added to a zip as it is encoded and the resulting bytes are uploaded to Blob as
8 MB multipart parts, two in flight (`lib/roboflow-sink.ts`). Nothing waits for
the finished archive, so a 2 GB library costs the same memory as a 20 MB one.

**Reading it back.** That archive is never downloaded either, on either side. The
asset route indexes it with the same trick used on the export — read the central
directory once, then pull single entries by byte range (`lib/zip-format.ts`, and
`lib/roboflow-archive.ts`, which keeps the parsed index per instance) — so
serving one thumbnail out of a 600 MB library costs one small ranged read.

Measured on a 2 GB export (3,600 images), read from a local range-serving host:
23s, zero bytes written to disk, and a steady state of ~440 MB RSS that does not
move when the same process ingests it three times over.

**Choosing tiles.** What caps a build is what the mosaic can draw, not what the
host can hold: the frame is 1600px and the finest cell is 8px, so past ~20,000
tiles the extra ones are images the ingest re-encodes for nothing. A dataset
with more images than that is sampled evenly across the whole export rather than
truncated at the front, and when the deadline is the tighter constraint the sample
shrinks to what can be fetched and decoded in the time left. A build that runs out
of time publishes the tiles it has instead of failing, which keeps the download
fast for the reader and the result honest — the page says when a mosaic is drawn
from a sample.

## Layout

| Path                                       | What                                                   |
| ------------------------------------------ | ------------------------------------------------------ |
| `app/roboflow/`                            | the page                                               |
| `components/roboflow-mosaic.tsx`           | URL input → ingest → hand off to CanvasHero            |
| `components/roboflow-reference-picker.tsx` | project cover, or a grid of the dataset                |
| `lib/mosaic-source.ts`                     | where tiles come from (Roboflow)                       |
| `lib/roboflow.ts`                          | URL parsing, slugs, asset URLs (shared client/server)  |
| `lib/roboflow-api.ts`                      | the two Roboflow REST calls                            |
| `lib/roboflow-ingest.ts`                   | tile sampling, thumbnail and signature build           |
| `lib/zip-format.ts`                        | the zip format itself, shared by both readers below    |
| `lib/roboflow-zip.ts`                      | the remote export, read over HTTP without a temp file  |
| `lib/zip-index.ts`                         | a published archive, read one named entry at a time    |
| `lib/roboflow-archive.ts`                  | that reader over Blob, index cached per instance       |
| `lib/roboflow-sink.ts`                     | where a built library goes (Blob multipart, or a dir)  |
| `lib/roboflow-store.ts`                    | local cache, status, job registry                      |
| `lib/roboflow-blob.ts`                     | durable status and the published archive's keys        |
| `lib/roboflow-control.ts`                  | distributed leases and public-ingest rate limits       |
| `lib/roboflow-limits.ts`                   | shared server and browser resource ceilings            |
| `lib/roboflow-pack.ts`                     | the browser's manifest and signature load              |
| `app/api/roboflow/ingest/`                 | start (POST) / poll (GET) an ingest                    |
| `app/api/roboflow/asset/[slug]/[...path]/` | one file: from the cache dir, or ranged out of Blob    |
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
