# Mosaic pipeline — reference & command cookbook

Consolidated state + commands as of 2026-06-13. Two pipelines live in this repo:
- **`pipeline/`** — scrape Knicks videos, sample frames, build a signature index, push to Supabase.
- **`video-generation/build_mosaic.py`** — the photomosaic generator (reconstruct a reference image from the full frame pool).

There's also an upstream **Node video-mosaic** pipeline (`pipeline/02-match.mjs`, `03-clips.mjs`, `04-render.mjs`, `config.mjs`, `lib/`) that renders an animated mp4 mosaic — not used by the Python photomosaic flow.

---

## Current data state
- **58 source videos** in `pipeline/videos/` (15 YouTube-id named + 43 from the `forty` folder, safe-renamed).
- **Frame index: 77,144 signatures @ 5 fps** in `pipeline/data/index/` (`signatures.bin` ~59MB, `manifest.json`, `videos/` = 116 per-video cache files).
- **Supabase** project `qnpwjltgxgkohtqhprux`, private bucket **`knicks-clips`**:
  - `videos/` — 58 full source mp4s
  - `clips/` (120) + `frames/` (120) — from the earlier diversity clip pass
  - `index/` — `manifest.json` + `signatures.bin` + `cache/` (116 per-video sigbins)
  - `clips.json`, `youtube_videos.csv` / `.json` (58 videos)
- **Tables NOT created**: `youtube_videos` and `clips` need `pipeline/supabase_schema.sql` run once in the Supabase SQL editor. Until then table upserts no-op; Storage works.

---

## Command cookbook (run from repo root unless noted)

**Download specific videos** (cookies + tv_embedded, retries):
```
python pipeline/download_ids.py <id-or-url> [<id-or-url> ...]
```

**Ingest a folder of local videos** (safe-rename into pipeline/videos/ + CSV rows):
```
python pipeline/ingest_forty.py /path/to/folder
```

**Upload new videos + refreshed CSV to Supabase** (skips ones already in bucket):
```
cd pipeline && python update_and_upload.py
```

**Re-index all videos** (incremental — only new videos decode; rest reuse cache):
```
cd pipeline && MOSAIC_SAMPLE_FPS=5 python 01-index-frames.py
```

**Push the index to Supabase** (`index/` prefix):
```
cd pipeline && python push_index.py
```

**Pull videos from Supabase that are missing locally** (CSV-driven, downloads only what's absent):
```
cd pipeline && python sync_videos.py
```

**Build a photomosaic** (the main tool):
```
python video-generation/build_mosaic.py \
  --reference /path/to/reference.png \
  --out-name mosaic_xyz.png \
  --cells 10000 --tile-px 32 \
  --reuse-cap 5 --min-dist 4 \
  --exclude-sec 3 --sim-rms 12 --flatness-min 3
```
Output -> `video-generation/output/<out-name>` + `_poster.jpg`. Reads the local index + extracts winning frames from `pipeline/videos/` (cached in `video-generation/.cache/tiles/`).

---

## build_mosaic.py flags
- `--reference` image to reconstruct; `--out-name` output filename (in `output/`).
- `--cells N` target total cell count; cols/rows derived from the reference aspect. (Else `--cols/--rows`, or `--cell` = ref_w/cell.)
- `--tile-px P` output pixels per tile, **decoupled** from grid density. Output = cols*P x rows*P (high-res). Default = `--cell` (40).
- `--reuse-cap` max times one frame is used (lower = more distinct clips, grainier; higher = cleaner). 10/5/2 explored.
- `--min-dist` min cell distance between two uses of the same frame (anti-clustering, kills "same image in a row").
- `--exclude-sec` ±seconds around a pick blocked in the same video (default 3).
- `--sim-rms` within that window, only block frames whose RGB RMS diff < this (default 12). Distinct-looking frames nearby (black cut, scene change) are kept.
- `--flatness-min` drop frames with luma std below this (default 3; low keeps dark/near-black frames for night-sky regions).

## How the mosaic works
1. **Index** (`01-index-frames.py`): ffmpeg decodes each video at 5 fps, scales every frame to 16x16 RGB = 768-byte "signature". Cached per video by `contentHash + fps` -> reruns reuse, only new videos decode.
2. **Match** (`build_mosaic.py`): each frame -> 8x8 coarse signature. Reference split into cols x rows cells, each cell -> its own coarse signature. Greedy, most-distinctive cells first, min SSD, subject to reuse-cap + min-dist (spatial) + temporal-exclusion (similarity-gated).
3. **Render**: extract each winning frame at full res from its source video (`frameIndex / 5fps`), composite at `tile-px`.

---

## Key learnings / gotchas
- **YouTube throttle**: this machine's IP is flagged. Downloads intermittently fail with `Requested format is not available` (YouTube serves storyboard-only). Workaround (in `download_ids.py` / `diversity.py`): `--cookies-from-browser chrome` + `--extractor-args youtube:player_client=tv_embedded,web_safari,default` + retry the whole yt-dlp invocation ~5x. Single/few downloads sometimes work; bulk reliably fails. **Search/metadata is NOT throttled.** Cooldown is hours. yt-dlp is v2026.03.17 (old — upgrading may help). First Chrome-cookie use triggers a macOS Keychain prompt (approve it).
- **Supabase**: the secret key (`SUPABASE_SECRET_KEY` in repo-root `.env`) does Storage + PostgREST upserts, **not DDL**. The project's upload file-size limit was raised in the dashboard so large videos upload (bucket `file_size_limit` set to 50GB via API). Tables still need `supabase_schema.sql` run in the SQL editor.
- **Caching**: index per-video sigbins + extracted mosaic tiles are cached, so re-indexing and re-rendering are fast. Both are gitignored; index is also mirrored to Supabase `index/`.
- **Filenames**: source videos with spaces/unicode break Supabase object URLs — `ingest_forty.py` slugifies to `<slug>-<hash8>.mp4`.
- **pgrep self-match bug**: don't write `while pgrep -f "script.py"` waiters — the waiter's own command line matches the pattern and loops forever. Use `kill -0 <PID>`.

## Open items
- YouTube throttle blocking new downloads (wait / different network). Outstanding wanted videos: 5 long ones (`vcOv3Qt-TcQ`, `FQ_D1-DWsYo`, `qJA-LOPYX94`, `4uemplteguQ`, `sCNX9s0lBrM`) + 4 links (`gN6gh2roY08`, `mwXyLvyOHIo`, `u_8AsN96Dhc`, `0zpZ2tiB0xg`) all failed.
- `supabase_schema.sql` not yet run -> tables empty.
- `video-generation/output/` has many experiment PNGs (various refs/caps/resolutions).
- Rotate `SUPABASE_SECRET_KEY` / `OPENAI_API_KEY` (pasted in chat earlier).
