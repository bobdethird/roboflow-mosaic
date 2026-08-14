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

Set `ROBOFLOW_API_KEY` on the project. Seeding no longer runs on the serverless
CPU: Vercel only resolves the dataset and pages image metadata. The visitor's
browser downloads the thumbnails and builds the tile library locally.

An optional `BLOB_READ_WRITE_TOKEN` is still used by the older server ingest
and the asset route, but it is not required for the page to load a dataset.

Resolve requests that use the server key are same-origin and rate-limited.

## How it works

**1. Ingest (browser, `lib/roboflow-client-ingest.ts`).** The URL is resolved
through a thin JSON route into `workspace / project / version`. The server
pages Roboflow's project search (`POST …/search`, `in_dataset: true`) and
returns thumbnail URLs. The browser then downloads those thumbs — directly from
Roboflow's CDN when CORS allows, otherwise through `/api/roboflow/thumb` —
and a pool of local seed workers turns each one into:

- a **stable id** (sha1 of the Roboflow image id), which de-duplicates the same
  photo if it appears more than once,
- a **16×16×3 colour signature**, packed into the 8×8 uint16 fixed-point format
  the mosaic worker compares on,
- a **thumbnail** (192px long edge), kept as a blob URL in this tab.

The project's cover image is downloaded alongside them (`project.icon` from the
Roboflow API, capped at 1600px, aspect preserved). After a minimum usable
batch, and then every so often as more tiles land, the in-tab library is
advertised to the mosaic. The canvas can open while seeding continues; later
batches append.

The Node ingest in `lib/roboflow-ingest.ts` is still what `pnpm ingest:dir`
uses for a local folder of images.

**2. Generate (browser, unchanged engine + unchanged UI).** The reference is
handed to the existing contour-flow generator: a Sobel edge-vector field, Voronoi
cells pushed out of edges so cell borders settle along contours, one colour
signature per cell, and a min-error tile per cell drawn rotated along the local
contour.

For a library built in this tab, the generator already has the signatures and
blob URLs — nothing else is downloaded. Newly arrived tiles become candidates
on the next generation; an already-generated mosaic is left alone.

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

## Storage paths

**Browser (production path).** The seeded library lives in this tab as blob
URLs. Reloading the page seeds again — that is the point: the visitor's CPU
is what makes it fast.

**Local folder ingest.** `pnpm ingest:dir` still writes
`.roboflow-cache/<workspace>--<project>--v<n>/` as ordinary files, plus
immutable snapshots under `snapshots/<version>/`.

**Choosing tiles.** What caps a build is what the mosaic can draw, not what the
host can hold: the frame is 1600px and the finest cell is 8px, so past ~20,000
tiles the extra ones are images the ingest re-encodes for nothing. A project
with more images than that is sampled evenly across the whole set rather than
truncated at the front.

## Layout

| Path                                       | What                                                  |
| ------------------------------------------ | ----------------------------------------------------- |
| `app/roboflow/`                            | the page                                              |
| `components/roboflow-mosaic.tsx`           | URL input → client ingest → hand off to CanvasHero    |
| `components/roboflow-reference-picker.tsx` | project cover, or a grid of the dataset               |
| `lib/mosaic-source.ts`                     | where tiles come from (Roboflow)                      |
| `lib/roboflow.ts`                          | URL parsing, slugs, asset URLs (shared client/server) |
| `lib/roboflow-api.ts`                      | Roboflow project, search, and image REST calls        |
| `lib/roboflow-client-ingest.ts`            | browser thumbnail fetch, seed workers, local pack     |
| `lib/roboflow-seed-worker.ts`              | decode + signature + JPEG on the user's CPU           |
| `lib/roboflow-ingest.ts`                   | Node folder ingest (`pnpm ingest:dir`)                |
| `lib/roboflow-resolve.ts`                  | URL → dataset version (no image decode)               |
| `lib/zip-format.ts`                        | zip format primitives                                 |
| `lib/zip-index.ts`                         | named-entry reader over a zip                         |
| `lib/roboflow-sink.ts`                     | where seeded files go (Blob objects, or a dir)        |
| `lib/roboflow-store.ts`                    | local cache, status, job registry                     |
| `lib/roboflow-blob.ts`                     | durable status, snapshot keys, individual file reads  |
| `lib/roboflow-control.ts`                  | distributed leases and public-ingest rate limits      |
| `lib/roboflow-limits.ts`                   | shared server and browser resource ceilings           |
| `lib/roboflow-pack.ts`                     | published packs, plus in-tab libraries                |
| `app/api/roboflow/resolve/`                | resolve a Universe URL                                |
| `app/api/roboflow/images/`                 | one page of project images + thumb URLs               |
| `app/api/roboflow/thumb/`                  | CORS fallback for one thumbnail                       |
| `app/api/roboflow/ingest/`                 | leftover server ingest (not used by the page)         |
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

This is also how to exercise the Node pipeline without an API key.

## What was removed

The inherited pages (`/knicks-mosaic`, `/newyork-mosaic`, `/bake`, `/m/<id>`,
`/admin`, the landing page and gallery) and everything only they used — the
Supabase proxy, share/publish flow, submission routes, auth/admin helpers,
era-emphasis matching, and baked gallery assets — are deleted. `/` redirects to
`/roboflow`. Local development only needs `ROBOFLOW_API_KEY`.
