# Mosaic Pipeline

Fresh mosaic video pipeline. This folder is the new canonical pipeline root; old
pipeline files are useful as reference only.

## Step 1: Sync Videos And Index Frames

```bash
cd mosaic-pipeline
python3 -m pip install -r requirements.txt
python3 01-sync-and-index.py
```

What it does:

- Imports existing local videos into `mosaic-pipeline/videos/`.
- Downloads missing videos from Supabase Storage bucket `knicks-clips/videos/`.
- Builds `data/index/manifest.json` and `data/index/signatures.bin`.
- Caches per-video signature files under `data/index/cache/`.
- Deduplicates exact videos by SHA-256 before indexing.
- Reuses existing signature caches from the old pipeline when content hashes and
  sample FPS match.

By default, local imports use hard links from `../pipeline/videos`, so this
should not duplicate the multi-GB video set on disk. Override sources with:

```bash
python3 01-sync-and-index.py --local-source /path/to/videos
```

Useful options:

```bash
python3 01-sync-and-index.py --skip-supabase
python3 01-sync-and-index.py --index-only
python3 01-sync-and-index.py --sample-fps 5
python3 01-sync-and-index.py --workers 6
python3 01-sync-and-index.py --index-workers 4 --download-workers 4 --hash-workers 8
MOSAIC_LOCAL_VIDEO_DIRS="/path/a:/path/b" python3 01-sync-and-index.py
```

Speed notes:

- Hashing, Supabase downloads, and ffmpeg signature indexing are worker-capped.
- `--workers` sets the default for all three phases.
- `--index-workers` is the most sensitive knob because every worker runs a full
  video decode. If the machine gets sluggish, lower this first.
- Default cache sources include `../pipeline/data/index/videos` and related
  cache folders. Add more with `--cache-source /path/to/cache`.

Required Supabase env vars are loaded from `../.env` and `../.env.local`:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
MOSAIC_CLIPS_BUCKET=knicks-clips
```

Important invariant: the index is frame-number based. Later render steps should
reproduce the same `fps=<sample_fps>` stream and select by frame number, not by
timestamp seeking.

## Step 2: Match Grid Cells

```bash
cd mosaic-pipeline
python3 02-match-cells.py --reference ../reference.png
```

What it writes:

- `data/matches/grid-plan.json`
- One assignment per grid cell.
- One `usedFrames` entry per distinct indexed frame.
- Exact frame identity for later extraction: `sourcePath`, `videoId`,
  `frameIndex`, `globalFrame`, and `candidateKey`.

The video mosaic is grid-only for now. Defaults are `3840x2160`, `96x54`
cells, 30 fps output timing, and 28 seconds of pre-roll timing metadata for
later clip extraction.

Useful options:

```bash
python3 02-match-cells.py --cols 96 --rows 54
python3 02-match-cells.py --cells 5000
python3 02-match-cells.py --reuse-cap 20 --min-dist 4
python3 02-match-cells.py --match-grid 8 --clean-rms 12
python3 02-match-cells.py --require-full-preroll --pre-roll-sec 28
```

By default, Step 2 derives the grid and output dimensions from the reference
aspect. If you pass both `--cols` and `--rows` or both `--output-width` and
`--output-height`, those explicit values win.

Matching uses the lessons from the still-image work:

- Keep flat frames by default (`--flatness-min 0`) so clean blacks remain
  available.
- Use a texture/cleanliness tiebreak (`--clean-rms`) for color-tied frames.
- Avoid exact-frame clustering with `--reuse-cap` and `--min-dist`.
- Block only near-identical same-video neighbors inside `--exclude-sec`.

## Step 3: Prepare Tile Clips

```bash
cd mosaic-pipeline
python3 03-prepare-clips.py
```

What it writes:

- `data/clips.json`
- Cached proxy clips under `data/clip-cache/`.
- By default, one `preroll.mp4` plus one exact `match.jpg` per distinct frame in
  `data/matches/grid-plan.json`.

The exact match still is always extracted with the same `fps=<sample_fps>`
stream used by Step 1. The animated pre-roll is extracted near the matched
timestamp and cached as a compact proxy video, while `match.jpg` stays pristine
for the opening/held/final mosaic frame.

If you are migrating from the old JPG-sequence cache, free disk space first and
rebuild Step 3. The cache key includes the storage format and proxy settings, so
video clips do not reuse old `frame_*.jpg` directories.

Video caches use adaptive sizing by default: each clip is cached at the largest
resolution it is displayed during the zoom, sized against the native plan width
(`grid.outputWidth`) and capped at `1080x1080`. `--opening-width` and
`--opening-height` still override the opening/center tile and can exceed that
cap when you want a sharper hero. If you render wider than
`--target-output-width`, the most-zoomed tiles may upscale.

Useful options:

```bash
python3 03-prepare-clips.py --workers 4
python3 03-prepare-clips.py --oversample 2
python3 03-prepare-clips.py --width 96 --height 96
python3 03-prepare-clips.py --oversample 8 --opening-width 720 --opening-height 720
python3 03-prepare-clips.py --exact-chunk-size 32
python3 03-prepare-clips.py --cache-format video --proxy-codec libx264 --proxy-crf 18 --proxy-keyint 15
python3 03-prepare-clips.py --sizing adaptive --target-output-width 3840 --max-tile-px 1080
python3 03-prepare-clips.py --sizing uniform --oversample 8
python3 03-prepare-clips.py --cache-format jpg      # legacy frame sequence mode
```

Speed notes:

- Exact matched frames are batched by source video, so each source video is
  decoded in bounded chunks for all exact final frames needed by this plan.
- Pre-roll proxy clips are prepared in parallel.
- Adaptive sizing starts the largest clips first so high-resolution central
  tiles do not become the tail of a multi-worker run.
- Proxy video avoids writing hundreds of thousands of separate JPG files. For a
  large 96x96 plan, expect `data/clip-cache/` to be low-GB instead of tens of GB.
- `--seek-margin-sec` controls the hybrid seek: ffmpeg fast-seeks just before
  the clip start, then accurately seeks inside that short window.

## Step 4: Render Photo Mosaic

```bash
cd mosaic-pipeline
python3 04-render-photo.py
```

What it writes:

- `output/mosaic.png`
- `output/mosaic_poster.jpg`

This first Step 4 is still-image only. It can run directly after Step 2: it
reads `data/matches/grid-plan.json`, extracts the exact matched frames into
`data/photo-frame-cache/`, and fills the assigned grid cells. Step 3 is not
required unless you want to reuse already-prepared clip frames.

Useful options:

```bash
python3 04-render-photo.py --out output/ref-mosaic.png
python3 04-render-photo.py --poster-width 1920
python3 04-render-photo.py --output-width 3840 --output-height 2160
python3 04-render-photo.py --extract-method timestamp --workers 6
python3 04-render-photo.py --workers 3 --extract-chunk-size 32
python3 04-render-photo.py --output-aspect reference
python3 04-render-photo.py --use-clips
```

## Step 5: Render Mosaic Video

```bash
cd mosaic-pipeline
python3 05-render-video.py
```

What it writes:

- `output/mosaic.mp4`
- `output/mosaic_poster.jpg`
- Cached intermediate frames under `data/render-frames/<hash>/` (interrupted
  renders resume; a matching cache writes nothing).

This requires Step 3 (`data/clips.json`): the video needs the animated proxy
clips, not just the matched stills.

The camera math is a direct port of the reference pipeline
(`../pipeline/lib/grid.mjs` + `../pipeline/04-render.mjs`):

- The camera opens framed on the opening cell (expanded to the output aspect so
  it never distorts) and zooms out with a constant zoom factor (window size is
  geometric in time), panning the top-left toward `(0, 0)`.
- Each tile plays the trailing portion of its pre-roll and settles onto its
  matched frame at a per-cell **finish time**, then holds. Finish times are
  spread across the timeline (see `--finish-distribution`) so tiles lock in
  progressively instead of all landing at once.
- After the zoom completes the final mosaic is held for `freezeSec`. Those
  frames are identical, so they are rendered once and copied.

### Tile finish times (`--finish-distribution`)

Earlier builds played every tile its full `matchAtSec` of pre-roll and converged
on the matched frame at `clipFinishSec`. Because Step 2 caps each clip's pre-roll
at `preRollSec`, ~80% of clips share the exact same `matchAtSec`, so the vast
majority of tiles snapped to their final frame in the last instant. The renderer
now gives each non-opening cell its own finish time:

- `normal` (default): finish times follow a clamped bell curve centered before
  the end, so most tiles settle through the middle of the timeline and only a
  few stragglers remain for the final reveal.
- `uniform`: finish times are spread evenly across the window.
- `end`: legacy behavior — every tile lands together at `clipFinishSec`
  (this is the mode that honors `--repeat-time-jitter-sec`,
  `--play-start-stagger`, and `--tile-start-delay-sec`).

A cell whose finish time is early simply shows a shorter run-up (the tail of its
pre-roll); a cell with a late finish shows more of it. Whatever the distribution,
every tile is guaranteed to be on its matched frame by `clipFinishSec`, so the
freeze always shows the complete mosaic. Changing any finish setting invalidates
the render cache and re-renders the dynamic frames.

By default the zoom spans the full pre-roll and the final mosaic is held for the
plan's `freezeSec`, so the video is `preRollSec + freezeSec` long. If you pass a
shorter `--zoom-duration-sec`, the camera can finish zooming before the clips
finish; the renderer keeps the fully zoomed-out mosaic playing until
`preRollSec`, then holds the final mosaic for `freezeSec`. To slow the zoom
beyond the current plan, rerun Step 2 with a longer `--pre-roll-sec`, then rerun
Step 3 so the clip sequences cover the longer animation window.

Useful options:

```bash
python3 05-render-video.py --workers 6
python3 05-render-video.py --scale 0.25            # fast low-res preview
python3 05-render-video.py --preview-poster        # only the final still, no encode
python3 05-render-video.py --max-seconds 5         # render just the opening, for tests
python3 05-render-video.py --zoom-duration-sec 20 --zoom-hold-sec 4
python3 05-render-video.py --freeze-sec 6 --play-start-stagger 0.5
python3 05-render-video.py --loop-short-clips     # loop clips shorter than pre-roll until final approach
python3 05-render-video.py --start-clips-after-zoom-hold
python3 05-render-video.py --finish-distribution normal --finish-spread-sec 2.5
python3 05-render-video.py --finish-distribution normal --finish-center-sec 31 --finish-spread-sec 4
python3 05-render-video.py --finish-distribution uniform   # even spread of finish times
python3 05-render-video.py --finish-distribution end       # legacy: all tiles land together
python3 05-render-video.py --finish-seed 7                 # reshuffle which tiles finish when
python3 05-render-video.py --repeat-time-jitter-sec 2      # only used with --finish-distribution end
python3 05-render-video.py --output-width 1920 --crf 20 --preset medium
python3 05-render-video.py --time-tile-frames 12   # lower RAM, more decoder opens
python3 05-render-video.py --force                 # ignore the render cache
```

Speed notes:

- Dynamic frames are rendered in parallel across `--workers` processes as
  time-tiles. Each tile opens a clip proxy, decodes only the needed frame range,
  scatters those pixels into the output canvases, then closes the decoder.
- `--time-tile-frames` trades memory for fewer decoder opens. Higher values are
  usually faster but hold more full-size canvases in RAM per worker.
- `--finish-distribution` controls how tile finish (matched-frame) times are
  spread. `normal` (default) settles tiles across the timeline on a bell curve;
  `--finish-center-sec` / `--finish-spread-sec` / `--finish-earliest-sec` tune
  it (defaults: center `clipFinish - 2*spread`, spread `2.5s`, earliest
  `clipStart + max(2s, 10% of pre-roll)`). `--finish-seed` reshuffles which
  cells finish when without changing the shape.
- `--loop-short-clips` keeps clips whose pre-roll is shorter than their assigned
  play window moving instead of freezing early. They loop until their final
  approach window, then play forward to the matched frame at their finish time.
- `--start-clips-after-zoom-hold` keeps the opening frame still during
  `--zoom-hold-sec`, then starts tile playback. The final mosaic hold begins at
  `zoomHoldSec + preRollSec` if that is later than the zoom completion.
- `--repeat-time-jitter-sec`, `--play-start-stagger`, and
  `--tile-start-delay-sec` only apply to `--finish-distribution end`; the
  distributed modes desync repeated clips via their per-cell finish times. The
  opening cell always plays from `t=0` and is never delayed by any of these.
- The most expensive frames are near full zoom-out (every cell visible); use
  `--scale` or `--max-seconds` for quick iteration before a full render.
- Tile sharpness at high zoom is limited by Step 3's tile resolution
  (`--oversample`), since tiles are extracted at a fixed multiple of the cell
  size rather than their maximum on-screen size.
