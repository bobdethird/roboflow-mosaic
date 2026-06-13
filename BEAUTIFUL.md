# BEAUTIFUL.md — how the photomosaic was made clean

This documents the methodology that took the Knicks photomosaic from "muddy with
random bright speckle" to clean, the final command that produces it, and the
Supabase setup the pipeline depends on.

The generator is `video-generation/build_mosaic.py`. It reconstructs a reference
image out of frames sampled from every source video in the index.

---

## TL;DR — the final command

```bash
python3 video-generation/build_mosaic.py \
  --reference video-generation/output/ex.png \
  --out-name mosaic_ex_fixed.png \
  --cells 10000 --tile-px 32 \
  --reuse-cap 10 --min-dist 4 \
  --match-grid 8 --clean-rms 12
```

Swap `--reference` (and `--out-name`) for any other image — e.g. `reference.png`
(the crowd) — and keep the rest identical. Output lands in
`video-generation/output/<out-name>` plus a `_poster.jpg` preview.

What each flag does and why it's set this way:

| Flag | Value | Why |
|------|-------|-----|
| `--cells` | `10000` | Target tile count; cols/rows derived from the reference aspect. |
| `--tile-px` | `32` | Output pixels per tile (decoupled from grid density). |
| `--reuse-cap` | `10` | Max times one frame may be used. ~10 keeps it clean without collapsing variety. |
| `--min-dist` | `4` | Min cell distance between two uses of the same frame (anti-clustering). |
| `--match-grid` | `8` | Color-match each tile at 8×8. (16 is available; it was **not** the fix — see below.) |
| `--clean-rms` | `12` | Cleanliness tiebreak: among color-tied frames, pick the one whose flatness matches the cell. |
| `--flatness-min` | `0` (default) | **Keep every frame.** Nothing is discarded — including clean blacks. |

---

## The methodology — how we diagnosed and fixed it

The mosaic looked bad (muddy, with scattered bright squares in dark regions).
We worked through hypotheses in order, **measuring** each instead of guessing.
The order matters; most of these were dead-ends that ruled out a suspect.

### 1. "More frames should look better" — ruled out
Restricting the pool from 77k frames (58 videos) down to 5 videos produced a
near-identical result. The matcher already saturates on a few thousand
good-average-color frames; raw count was never the bottleneck.

### 2. The flatness filter was throwing away the best tiles — real, fixed
The data contains **58 perfectly black frames** (luma 0). The old default
`--flatness-min 3` dropped them as "slates," so when a cell wanted black it was
forced onto noisy near-black frames. **Fix:** default `--flatness-min 0` — keep
all data. (Set it higher only if you want to drop solid title cards.)

### 3. The "equidistant trap" — understood, motivated the tiebreak
Matching minimizes color distance, so a clean black frame (luma 0) is *exactly
as far* from a grey-10 cell as a noisy grey-20 frame is. The matcher had no
reason to prefer the clean one. **Fix:** the **cleanliness/texture tiebreak**
(`--clean-rms`): among frames within RMS 12 of the best color match, pick the one
whose own flatness best matches the cell's. Flat cells (sky, dark suit, white
jersey) get clean flat tiles; detailed cells still get detailed tiles.

### 4. Is 8×8 matching losing information? — tested, NOT the cause
The signatures are stored at 16×16 but matched at 8×8 (a 2×2 box-average). The
hypothesis: averaging dilutes bright outliers, letting specky frames match dark
cells. We added `--match-grid 16` (uses the full stored signature, free — no
re-indexing). It sharpened the figure slightly but **did not remove the
speckle**. Speckle was constraint-independent and grid-independent — a strong
signal the cause was elsewhere. We reverted the default to `8`.

### 5. Is the index itself scrambled (offset/representation desync)? — ruled out
"Worked separately, broke when combined" is the classic signature of a
concatenated-index offset bug, so we checked hard:
- `signatures.bin` rows (77,144) == `sum(manifest frameCount)` ✓
- 0 offset-continuity or per-video cache-rowcount mismatches across all 58 videos ✓
- Stored-vs-reextracted signature RMS of **0.6–4.4** for the big videos that
  dominate the pool ✓
The index is correctly aligned. Global index → video → frame mapping is sound.

### 6. The actual bug: **extraction rendered the wrong frame** — fixed
The index is built by running an `fps=5` filter over each full video and storing
the signature for frame **number** `li`. The old extractor fetched tiles by
**timestamp** (`ffmpeg -ss <t> -i video`), which keyframe-snaps. Across a scene
cut it lands on the *wrong side* — so a cell correctly matched to a **dark**
signature got a **bright** tile rendered into it. That is the speckle.

Measured on the cached tiles: **33%** differed from their own signature by >20
luma; **606** were >60 *brighter*. Examples: signature luma `2.9` → rendered
`181.5`; `0.0` → `135.2`.

**Fix:** extract the same way we index — replicate the `fps=N` filter and select
by frame **number**, not timestamp:

```
ffmpeg -i <video> -vf "fps=5,select='eq(n\,<li1>)+eq(n\,<li2>)+...',scale=...,crop=..." \
       -vsync 0 -frames:v <count> tile_%d.jpg
```

Verified per-frame RMS = **0.0** (the tile is now *exactly* the frame its
signature represents). Extraction is batched one decode per video.

**Result:** bright-speckle tiles went **393 → 0**; dark-region brightness error
halved (15.2 → 6.1 luma); overall tile error down 43% (18.5 → 10.6).

### Note on speed
Frame-number accuracy means ffmpeg cannot seek — it decodes each video from the
start to reach the needed frame numbers, so a full build is bottlenecked on the
longest videos (~100s for this set). The old timestamp-seek was fast only because
it cheated (and was wrong). A future optimization: keyframe-seek to ~0.5s before
each frame, then decode just that short window — avoids the wrong-side-of-cut
error while decoding ~1s instead of the whole file.

### What was NOT the problem
Indexing, offset alignment, the MSE math, the 8×8 reduction, the pool size, and
the constraints were all investigated and cleared. The single root cause was
timestamp-based extraction landing on the wrong frame across scene cuts.

### Explicitly out of scope
**No tile tinting.** Blending tiles toward the target color is disallowed —
every tile must be a real, unaltered source frame.

---

## How the mosaic works (architecture)

1. **Index** (`video-generation/01-index-frames.py`, mirrors `pipeline/`): ffmpeg
   decodes each video at 5 fps, scales every frame to 16×16 RGB = a 768-byte
   signature. Cached per video by `contentHash + fps`, so re-indexing only
   decodes new videos. Output: `pipeline/data/index/{manifest.json,
   signatures.bin, videos/<hash>.5fps.sigbin}`.
2. **Match** (`build_mosaic.py`): each frame → coarse signature at `--match-grid`.
   The reference is split into cols×rows cells, each → its own coarse signature.
   Greedy, most-distinctive cells first, min SSD (`d = ‖frame − cell‖²`), subject
   to reuse-cap + min-dist (spatial) + temporal-exclusion + the cleanliness
   tiebreak.
3. **Render** (frame-accurate): each winning frame is extracted at full res via
   the `fps=N` + `select=eq(n,li)` filter (cached in
   `video-generation/.cache/tiles/`) and composited at `--tile-px`.

Re-index from scratch (only needed for new videos):
```bash
cd pipeline && MOSAIC_SAMPLE_FPS=5 python 01-index-frames.py
```

---

## Supabase process & configs

The frame index and source media are mirrored to Supabase so a fresh machine can
pull them instead of re-downloading 7.9 GB of video and re-decoding the index.

### Config (`.env` at repo root, loaded via `python-dotenv`)
```
NEXT_PUBLIC_SUPABASE_URL=https://<project>.supabase.co   # project URL
SUPABASE_SECRET_KEY=sb_secret_...                        # server secret/service key
MOSAIC_CLIPS_BUCKET=knicks-clips                         # optional; this is the default
```
- The secret key does **Storage + PostgREST upserts only — not DDL.** It cannot
  create tables.
- Project: `qnpwjltgxgkohtqhprux`, private bucket **`knicks-clips`**.
- The bucket's `file_size_limit` was raised (to 50 GB via API) so large source
  mp4s upload.

### Bucket layout (`knicks-clips`)
```
videos/   58 full source mp4s
index/    manifest.json + signatures.bin + cache/<hash>.5fps.sigbin (per-video)
clips/    + frames/   from the earlier diversity clip pass
clips.json, youtube_videos.csv / .json
```

### Tables (one-time, manual)
`youtube_videos` and `clips` must be created **once** in the Supabase SQL editor
by running `pipeline/supabase_schema.sql`. Until then, table upserts no-op
gracefully and Storage still works — a run is never blocked on the schema.

### Commands
```bash
# Publish the local index to Supabase (index/ prefix)
cd pipeline && python push_index.py

# Upload new videos + refreshed CSV (skips ones already in the bucket)
cd pipeline && python update_and_upload.py

# Pull videos referenced by the CSV that are missing locally (downloads only what's absent)
cd pipeline && python sync_videos.py
```

`supabase_push.py` is the thin thread-safe client used by these (PostgREST for
table upserts, Storage for uploads).

---

## Caching notes
- Per-video index sigbins and extracted mosaic tiles are cached and gitignored;
  the index is also mirrored to Supabase `index/`.
- If you change extraction logic, **wipe `video-generation/.cache/tiles/`** — old
  tiles extracted by the buggy timestamp method must be regenerated.
