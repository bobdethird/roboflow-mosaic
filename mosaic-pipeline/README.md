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
- Cached frame sequences under `data/clip-cache/`.
- One sequence per distinct frame in `data/matches/grid-plan.json`.

The last frame of every sequence is always the exact indexed match frame,
extracted with the same `fps=<sample_fps>` stream used by Step 1. The animated
pre-roll is extracted near the matched timestamp, then the exact matched frame
is appended for freeze/render alignment.

Useful options:

```bash
python3 03-prepare-clips.py --workers 4
python3 03-prepare-clips.py --oversample 2
python3 03-prepare-clips.py --width 96 --height 96
python3 03-prepare-clips.py --exact-chunk-size 32
```

Speed notes:

- Exact matched frames are batched by source video, so each source video is
  decoded in bounded chunks for all exact final frames needed by this plan.
- Pre-roll frame sequences are prepared in parallel.
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

This requires Step 3 (`data/clips.json`): the video needs the animated tile
sequences, not just the matched stills.

The camera math is a direct port of the reference pipeline
(`../pipeline/lib/grid.mjs` + `../pipeline/04-render.mjs`):

- The camera opens framed on the opening cell (expanded to the output aspect so
  it never distorts) and zooms out with a constant zoom factor (window size is
  geometric in time), panning the top-left toward `(0, 0)`.
- Each tile plays from a per-cell staggered start toward its matched frame,
  reaching the exact matched frame at the clip's `matchAtSec`.
- After the zoom completes the final mosaic is held for `freezeSec`. Those
  frames are identical, so they are rendered once and copied.

By default the zoom spans the full pre-roll and the final mosaic is held for the
plan's `freezeSec`, so the video is `preRollSec + freezeSec` long.

Useful options:

```bash
python3 05-render-video.py --workers 6
python3 05-render-video.py --scale 0.25            # fast low-res preview
python3 05-render-video.py --preview-poster        # only the final still, no encode
python3 05-render-video.py --max-seconds 5         # render just the opening, for tests
python3 05-render-video.py --zoom-duration-sec 20 --zoom-hold-sec 4
python3 05-render-video.py --freeze-sec 6 --play-start-stagger 0.5
python3 05-render-video.py --output-width 1920 --crf 20 --preset medium
python3 05-render-video.py --force                 # ignore the render cache
```

Speed notes:

- Frames are rendered in parallel across `--workers` processes, each handling a
  contiguous range so the per-clip frame cache stays warm.
- The most expensive frames are near full zoom-out (every cell visible); use
  `--scale` or `--max-seconds` for quick iteration before a full render.
- Tile sharpness at high zoom is limited by Step 3's tile resolution
  (`--oversample`), since tiles are extracted at a fixed multiple of the cell
  size rather than their maximum on-screen size.
