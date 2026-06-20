# Mosaic

A photomosaic generator built from a large library of basketball video clips. A
reference image is reproduced as a grid of tiles, where every tile is a real
frame pulled from a source video. The project produces two artifacts from the
same data:

- a **still photo mosaic** (a single PNG), and
- a **zoom-out video mosaic** (an mp4 that opens framed on one tile and zooms
out to reveal the whole picture while each tile plays the clip it was taken
from and settles onto its matched frame).

The last frame of the video is exactly the still mosaic.

Separately, the **website** ships its own interactive, in-browser mosaic engine —
a *different* algorithm (Voronoi contour-flow, with photo tiles) used on pages
like `/knicks-mosaic`. So the repo really holds **two mosaic systems**: the
offline Python pipeline (System 1, below) and the browser engine (System 2,
documented further down). They share only Supabase as a store.

## Repository layout

- `mosaic-pipeline/` — the **canonical** generation pipeline (5 numbered
stages). This is where everything below lives. See
`[mosaic-pipeline/README.md](mosaic-pipeline/README.md)` for the full command
cookbook and per-flag reference.
- `website/` — the Next.js site. Hosts **System 2**: the in-browser mosaic
engine (`lib/mosaic*.ts`), the interactive pages (`app/knicks-mosaic`,
`app/newyork-mosaic`, `app/mosaic`), the offline "bake" tooling (`app/bake`,
`app/api/bake`), and the Supabase storage proxy
(`app/api/mosaic/[...path]/route.ts`).
- `pipeline/` — the previous-generation JS pipeline, kept as reference. The
video camera math in the new pipeline is a direct port of
`pipeline/lib/grid.mjs` + `pipeline/04-render.mjs`.
- `source-videos/`, `video-generation/`, `ballerina-sample/`, `deprecated/` —
source assets and older experiments.

---

## System 1 — the offline Python pipeline (`mosaic-pipeline/`)

This system reproduces a reference image as a **rectangular grid** whose tiles
are **frames pulled from source videos**, and renders a still PNG plus a
zoom-out video. It runs as a CLI (needs ffmpeg + NumPy), not in the browser.

The pipeline is five stages. Stages 1–3 build a shared **data + grid** layer;
stages 4 and 5 are the two renderers that consume it.

### Stage 1 — Index every source frame as a tiny signature

Each source video is decoded at a fixed `sample_fps` and every sampled frame is
reduced to a **16×16×3 RGB "signature"** (768 bytes). All signatures are
concatenated into one flat binary blob (`data/index/signatures.bin`), and
`manifest.json` records, per video, its `frameOffset` / `frameCount` into that
blob plus a content hash.

Design choices:

- **Frame-number identity, not timestamps.** This is an explicit invariant:
later stages reproduce the same `fps=<sample_fps>` stream and select frames *by
frame number*. Timestamp seeking drifts between ffmpeg invocations; frame
indexing is deterministic, so the frame you matched on is exactly the frame you
later extract.
- **A 16×16 thumbnail is the whole "image."** Matching never touches
full-resolution pixels — it works on 768-byte vectors, which is what makes
matching tens of millions of frames tractable in NumPy.
- Videos are deduplicated by SHA-256, and signature caches are reused when the
content hash and sample FPS match, so the multi-GB video set is not re-decoded
unnecessarily.

### Stage 2 — Build the grid and match cells to frames

This stage (`02-match-cells.py`) is the brain. It produces
`data/matches/grid-plan.json`, the single source of truth both renderers read.

**Deriving the grid.** The reference image's aspect ratio drives `cols × rows`.
You can pass `--cols/--rows`, a target `--cells` count (it solves
`cols = round(√(cells·aspect))`), or `--cell-px`; otherwise it defaults to 96
columns and derives rows from the aspect.

**Cell signatures.** The reference is resized to `(cols·g, rows·g)` where
`g = match_grid` (default 8) and each cell becomes a `g×g×3` vector — the same
representation as the source frames. (The 16×16 source signatures are
downsampled to 8×8 for matching: coarser is more robust to per-frame noise and
cheaper to compare.)

**The matching loop** — most of the design decisions live here:

1. **Candidate filtering up front.** A frame is eligible only if it passes a
  flatness floor, belongs to a selected video, and is at least `min_clip_sec`
   into its source. That last filter matters because the video renderer needs
   *pre-roll footage before* the matched frame to zoom through.
2. **Distance is vectorized L2 (SSD):** `‖tile − cell‖²` computed for every
  candidate against the current cell in one matrix op
   (`tile² − 2·(tiles·cell) + cell²`).
3. **Four-level constraint relaxation.** Each cell tries to satisfy all
  constraints, dropping them progressively if nothing qualifies: (0) respect
   spatial separation + temporal blocking + reuse cap, (1) drop spatial, (2)
   drop temporal, (3) drop reuse cap. This guarantees every cell gets *something*
   while honoring quality constraints whenever possible; the chosen relax level
   is recorded per cell.
4. **Texture tiebreak among color-ties.** Rather than blindly taking the nearest
  color match, it keeps the top-`cand_k` candidates within a small radius of the
   best and, among those, picks the one whose luma std (texture/contrast) is
   closest to the cell's. Two frames that are equally the right *color* are
   disambiguated by matching *busyness* — this avoids flat walls of same-color
   tiles.
5. **Anti-clustering.** `reuse_cap` limits how many cells can use the exact same
  frame; `min_dist` keeps repeats spatially separated; and after each placement,
   near-duplicate frames from the *same video near the same timestamp* are marked
   temporally blocked, so the same shot isn't repeated from adjacent frames.
6. **Cell ordering.** By default "distinctive" — high-variance cells are matched
  first, so the visually important cells get first pick of the frame pool before
   reuse caps deplete it.
7. **The opening cell is special.** A designated opening cell (from
  `focus_x/focus_y`, default center) and an optional neighborhood radius can be
   restricted to chosen videos, so the hero tile the camera opens on is
   intentional rather than whatever happened to color-match.

The plan records, per cell: grid position, world-space rect (`x,y,w,h`), exact
frame identity (`sourcePath/videoId/frameIndex/globalFrame/candidateKey`), match
error, and relax level — plus a `usedFrames` list and the timing block
(`preRollSec`, `freezeSec`, `fps`).

### Stage 3 — Materialize tiles

For each *distinct* matched frame, `03-prepare-clips.py` writes two things into
`data/clips.json` + `data/clip-cache/`:

- a **pristine `match.jpg`** — the exact matched frame (frame-accurate, via the
same `fps` stream), used as the final settled tile, and
- a `**preroll.mp4` proxy** — a compact video of the footage *leading up to* the
matched frame, used for the animation.

Proxy **video** is used instead of a JPG sequence: a 96×96 plan would be tens of
GB as loose JPGs but only low-GB as proxies. Tiles are sized *adaptively* — each
cached at the largest size it's ever shown during the zoom (capped at 1080px) —
so central tiles are sharp without paying that cost for every tile.

---

### Renderer A — the still photo mosaic (`04-render-photo.py`)

The simple one. It produces a single PNG (`output/mosaic.png`) plus a JPEG
poster, and doesn't even need Stage 3 — it can extract matched frames straight
from the plan.

- **Frame-accurate extraction.** To grab one exact frame without decoding a whole
video, it fast-seeks to ~0.5s before the target, then uses `-copyts` so the
`fps=<sample_fps>` filter lands on the *same grid* a full decode would, and a
`select=between(...)` window isolates the single frame. Frame-number accuracy
at seek speed.
- **Compose.** A blank canvas; for each cell, integer bounds are computed with
`round(col·W/cols)`. Using rounded *shared edges* means adjacent cells meet
exactly with no gaps or overlap. Each frame is cover-fit (scale-to-fill +
center-crop) into its cell.

That's the entire still mosaic: grid + exact matched frames blitted into cells.
No motion, no camera — essentially "render the final frame of the video and
stop."

### Renderer B — the video mosaic (`05-render-video.py`)

Same grid and same matched frames, but now a camera zooms out while each tile
plays its pre-roll clip and settles onto its matched frame. This requires
Stage 3 (it needs the proxy clips, not just the stills).

**The camera (geometric zoom-out).** The video is one continuous zoom from the
opening cell out to the full mosaic.

- The **start window** takes the opening cell's rect and expands it to the output
aspect ratio (so the camera never distorts), clamped inside the world. That's
frame 1 — the hero tile filling the screen.
- The window width grows **geometrically**: `w = start_w · (world_w/start_w)^t`.
A constant zoom *factor* per unit time reads as a smooth, natural zoom (linear
size growth would feel like it accelerates). The top-left pans toward `(0,0)`
in proportion to size progress, so by `t=1` the window is the whole world.
- An optional `zoom_hold` parks the camera on the opening cell at the start. If
the zoom duration is shorter than the pre-roll, the camera finishes early and
the fully zoomed-out mosaic keeps playing until the clips finish.

**Tile finish times (the key design choice).** Stage 2 caps every clip's
pre-roll at `preRollSec`, so ~80% of clips share the same `matchAtSec`. A naive
"everything lands at the end" rule made the vast majority of tiles snap to their
final frame in the *same instant* — an ugly synchronized pop. Instead, each cell
gets its **own finish time** drawn from a distribution:

- `normal` (default): a bell curve centered before the end — most tiles settle
through the middle of the timeline, a few stragglers remain for the final
reveal.
- `uniform`: finish times spread evenly.
- `end`: legacy — every tile lands together.

Finish times are **deterministic** (hashed from cell index + seed), so a cell
finishes at the same moment every render (cache-stable) and `--finish-seed`
reshuffles *which* cell finishes *when* without changing the shape. Each tile
plays the *trailing portion* of its pre-roll so it lands exactly on the matched
frame at its finish time; with `--loop-short-clips`, tiles whose play window
exceeds their cached pre-roll loop until the final approach instead of freezing.

**Drawing a frame.** Compute the window for the current time; cull to only the
cells overlapping it (a handful at high zoom, all of them near full zoom-out —
those are the expensive frames); map each cell's world rect through the window
into canvas pixels; cover-fit the chosen clip frame using the same rounded
shared-edge trick so tiles abut seamlessly mid-zoom. Decodes are batched per clip
so each proxy is opened once for all the frames and placements that need it.

**Performance & correctness machinery.**

- **Static-tail optimization.** Once the camera is fully zoomed out *and* every
clip has reached its match, all remaining frames are identical, so that frame
is rendered once and copied for the entire freeze hold.
- **Content-hashed, resumable cache.** The render hash covers the plan, clips,
and every render parameter. A matching hash with valid outputs is an instant
cache hit; an interrupted run resumes from existing valid frames (dropping only
the newest, possibly half-written one). Frames are written to a temp file and
validated (JPEG end marker) before an atomic rename, so a killed process never
leaves a corrupt frame a resume would trust.
- **Parallel time-tiling.** Dynamic frames are split into contiguous time tiles
and rendered across a process pool; contiguous slices give clip-decode cache
locality, larger tiles mean fewer decoder opens but more RAM.
- Final encode is `libx264` from the JPEG frame sequence, plus a poster from the
last frame.

**One-sentence contrast:** both renderers read the same grid plan and the same
matched frames; the photo mosaic blits each cell's final frame into a static
canvas, while the video mosaic adds a zoom-out camera and plays each tile's
pre-roll so cells animate and settle onto those same final frames at staggered,
deterministic finish times.

---

## System 2 — the website mosaic engine (`website/`)

The site does **not** use the Python pipeline at request time. It has its own
mosaic engine that runs **entirely in the browser**, with a different layout
algorithm and a different look. This is what `/knicks-mosaic`, `/newyork-mosaic`,
and `/mosaic` render.

**Where the code lives.** `lib/mosaic.ts` (shared signature / edge / draw
helpers, used on both the main thread and the worker), `lib/contour-mosaic.ts`
(the Voronoi contour-flow layout), `lib/mosaic-worker.ts` (the Web Worker that
matches + renders), `lib/mosaic-client.ts` (`MosaicEngine`, the main-thread
handle), and `lib/photo-library.ts` (loads a collection's shared tile library).

**Tiles are photos from a shared Supabase library, not local video frames.**
Each collection is its own private bucket — `nyc-mosaic`, `caden-mosaic`
(password-gated), and `knicks-mosaic` (experimental: its "photos" are frames
sampled ~0.33fps from the scraped Knicks footage and seeded into the bucket, so
the *browser* engine ends up running on video frames too). A bucket holds a
`manifest.json`, a concatenated **coarse 8×8 signatures** blob, per-tile
`thumbs/<id>.jpg`, and optional `originals/<id>`. The browser downloads only the
manifest + the small signatures blob up front (cached in IndexedDB, keyed by
bucket + manifest version) and lazily fetches each tile's thumbnail through the
`/api/mosaic` proxy **only when that tile is actually placed**.

**Layout is contour-flow Voronoi, not a uniform grid.** For a given reference
image and cell size, the engine:

- computes an **edge-vector field** (Sobel) — both the strength and the direction
  of the reference's contours;
- seeds Voronoi cells pushed *out of* edges (so cell borders settle along
  contours) and tessellates them into polygons (`contour-mosaic.ts`);
- samples one **color signature per cell** from the reference at each cell center
  (`referenceWindowSignatures`);
- in the worker, matches each cell to the library tile with the lowest **MSE** on
  the 8×8 signature, then fills the polygon with that photo **rotated to run
  along the local contour**, with a grout gap, a soft drop shadow, and the
  reference's average color painted behind as grout (`drawPolygonCell`).

**Optional era weighting.** The knicks collection can bias matching toward recent
and playoff-window photos: each tile gets a multiplicative weight ≥ 1 and the
matcher minimizes `colorError / weight`, so a favored era only wins cells it's
*already* a reasonable color match for — it never forces a wrong-color tile.

**Output is interactive, not a file.** The worker streams progress snapshots as
the mosaic fills in and returns a transparent-background frame plus the per-cell
tile assignment. The page composites it over the grout color and supports pan /
zoom and hover-any-tile-to-see-the-source-frame.

Contrast with System 1: the Python pipeline makes a rectangular-grid mosaic from
*video frames* and renders a still PNG + a zoom-out **video** offline; the
website engine makes a Voronoi *contour-flow* mosaic from *library photos*,
interactively in the browser. `04-render-photo.py` and this engine both produce
"a photo mosaic," but they are different code paths with different output.

## Baking (static gallery pre-render)

The browser engine is too heavy to ship to every landing-page visitor, so the
landing page shows **pre-baked** mosaics. "Baking" runs the live browser
generation ahead of time and saves static artifacts:

- The dev-only `/bake` page (`lib/mosaic-bake.ts` + `app/bake/`) enumerates the
  reference photos in `public/gallery-original` (`/api/bake/list`).
- For each one it runs `generateBakedMosaic`, which mirrors the interactive
  generation **exactly** (same engine, same contour layout), producing the
  finished frame plus the per-cell tile assignment and centers.
- It POSTs the result to `/api/bake/save` (localhost + non-production only), which
  writes `public/gallery/<name>.jpg` (the flat mosaic image) and
  `public/gallery/<name>.json` (a cols×rows **hover hit-map** mapping each spot to
  the nearest source-frame index), then merges an entry into
  `public/gallery/index.json`.

At runtime the static masonry gallery just renders the baked JPEGs and reuses
each hit-map to power the **same hover-to-source popup** you get on
`/knicks-mosaic` — without loading the live engine. (`/newyork-mosaic` bakes its
hero through the same path; a name prefix lets the home grid skip it.)

## Supabase

Supabase Storage is the shared object store for source videos (System 1) and the
tile photo libraries (System 2). It's used on two sides.

### Pipeline side — pulling source videos down (Stage 1)

`01-sync-and-index.py` downloads any source videos it's missing before indexing.

- Configured from `../.env` / `../.env.local`: `NEXT_PUBLIC_SUPABASE_URL`,
`SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`), and the bucket
(`MOSAIC_CLIPS_BUCKET`, default `knicks-clips`) / prefix (default `videos`).
- The `SupabaseStorage` client authenticates with the secret key on both the
`apikey` and `Authorization: Bearer` headers and talks directly to the Storage
REST API (`/storage/v1/object/...`). It **lists** objects with a paged
`POST .../object/list/<bucket>` (1000 per page), filtering to video
extensions, then **downloads** each missing object by streaming
`GET .../object/authenticated/<bucket>/<path>` (falling back to the
unauthenticated path) to a `.part` temp file that's atomically renamed on
success.
- Only objects whose filename isn't already present locally are downloaded, and
downloads run across a thread pool (`--download-workers`). Use
`--skip-supabase` to index local videos only.

### Website side — serving objects back up through a proxy

The bucket is **private**, so the browser never talks to Supabase directly.
`website/app/api/mosaic/[...path]/route.ts` is a Next.js proxy that:

- authorizes every request (rejects clear cross-site requests via
`Sec-Fetch-Site`/Referer; password-gated buckets additionally require a valid
unlock cookie),
- validates the requested bucket against the known set so the proxy can't read
anything else in the project,
- fetches the object from Storage server-side using the secret key (forwarding
`Range` requests so video/large objects stream), and
- sets caching by object type: content-addressed `thumbs`/`originals` are
immutable and cached hard (gated → `private`, public → also CDN
`s-maxage`); mutable library files (manifest, signatures) stay fresh; gated
objects are never stored by a shared cache.

Net effect: the pipeline reads source videos *down* from Supabase, and the site
serves rendered assets *up* from it through an authorizing, cache-aware proxy —
the secret key never leaves the server in either direction.

---

## Running it

See `[mosaic-pipeline/README.md](mosaic-pipeline/README.md)` for the full
command cookbook (install, the current "Knicks" run commands, and every flag).
The short version:

```bash
cd mosaic-pipeline
python3 -m pip install -r requirements.txt
python3 01-sync-and-index.py     # index source frames (rerun only when the video set changes)
python3 02-match-cells.py ...    # build the grid match plan
python3 03-prepare-clips.py ...  # extract match stills + pre-roll proxies
python3 04-render-photo.py       # still mosaic  -> output/mosaic.png
python3 05-render-video.py ...   # video mosaic  -> output/mosaic.mp4
```

