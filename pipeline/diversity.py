#!/usr/bin/env python3
"""Color-diverse New York Knicks clip scraper (parallel, resumable, Supabase).

Goal: a library of >=500 clips whose END frames are all visibly different colors,
covering the whole spectrum. We download many genuinely-Knicks videos in parallel,
walk each at 1 fps, and keep a frame only when its dominant color is new (>= ΔE
from every color kept so far across ALL videos). Each kept frame is the LAST frame
of a 15-20s clip — we back up a random amount and cut from there.

  DISCOVER  yt-dlp search across many Knicks/NY query buckets -> deduped URLs
  DOWNLOAD  N videos at once (ThreadPool); reuse main.download_video
  SAMPLE    1 fps low-res frames (reuse main.sample_frames, cached)
  ANALYZE   OpenCV: reject near-black/blurry; k-means dominant color (CIELAB+RGB)
  SELECT    accept iff color is >= ΔE from every kept color (shared, locked)
  CLIP      back up random 15-20s; ffmpeg-cut -> clips/<id>_<NNN>.mp4
  PUBLISH   per clip: row + mp4 + frame -> Supabase; per video: youtube_videos row
  ADAPT     if the gamut stalls below --target, lower ΔE (floor) for new frames

State (clips.json + colors.json + processed list) is flushed continuously, so the
run is fully resumable. Source mp4s are deleted after processing (--keep-videos to
keep) since 500 colors can mean ~100+ multi-hundred-MB downloads.

Usage:
  pip install -r requirements.txt           # yt-dlp + ffmpeg on PATH
  python diversity.py --target 500 --workers 4
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import random
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np

from main import (
    SCRIPT_DIR,
    VIDEOS_DIR,
    capture_frame,
    fmt_timestamp,
    sample_frames,
)
import supabase_push

# --- Paths -----------------------------------------------------------------
CLIPS_DIR = SCRIPT_DIR / "clips"
CLIPFRAMES_DIR = SCRIPT_DIR / "clip-frames"
CLIPS_JSON = SCRIPT_DIR / "clips.json"
COLORS_JSON = SCRIPT_DIR / "colors.json"
VIDEOS_CSV = SCRIPT_DIR / "youtube_videos.csv"
PROCESSED_TXT = SCRIPT_DIR / ".cache" / "diversity-processed.txt"

# Relevance lives in the search: every query is unambiguously Knicks / NY, so any
# frame is fair game. Breadth across eras + the colorful NBA Cup courts maximizes
# the color gamut a single broadcast could never reach.
DEFAULT_QUERIES = [
    "New York Knicks 2025-26 season highlights",
    "New York Knicks NBA Cup highlights",
    "Knicks NBA Cup in-season tournament",
    "New York Knicks full game highlights 2025",
    "New York Knicks full game highlights 2024",
    "New York Knicks playoff highlights 2025",
    "Knicks vs Celtics highlights",
    "Knicks vs Pacers highlights",
    "Knicks vs Heat highlights",
    "Jalen Brunson highlights Knicks",
    "Karl-Anthony Towns Knicks highlights",
    "OG Anunoby Knicks highlights",
    "Mikal Bridges Knicks highlights",
    "Josh Hart Knicks highlights",
    "Julius Randle Knicks highlights",
    "Knicks Madison Square Garden crowd",
    "classic New York Knicks games",
    "1990s New York Knicks Patrick Ewing highlights",
    "New York Knicks 1994 finals",
    "Knicks Carmelo Anthony highlights",
    "Jeremy Lin Linsanity Knicks",
    "New York Knicks top plays of the season",
    "Knicks mixtape compilation",
    "New York Knicks dunks compilation",
    "New York Knicks buzzer beaters",
    "New York Knicks City Edition jersey",
]

SAMPLE_PX = 128


# --- Frame analysis --------------------------------------------------------
class FrameInfo:
    __slots__ = ("lab", "rgb", "hex", "brightness", "sharpness")

    def __init__(self, lab, rgb, hex_, brightness, sharpness):
        self.lab = lab
        self.rgb = rgb                # (r, g, b) 0-255 of the dominant color
        self.hex = hex_
        self.brightness = brightness
        self.sharpness = sharpness


def analyze_frame(path: Path) -> FrameInfo | None:
    img = cv2.imread(str(path))
    if img is None:
        return None
    h, w = img.shape[:2]
    scale = SAMPLE_PX / max(h, w)
    if scale < 1.0:
        img = cv2.resize(img, (max(1, int(w * scale)), max(1, int(h * scale))),
                         interpolation=cv2.INTER_AREA)

    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    brightness = float(gray.mean())
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())

    lab_img = cv2.cvtColor(img.astype(np.float32) / 255.0, cv2.COLOR_BGR2Lab)
    pixels = lab_img.reshape(-1, 3).astype(np.float32)
    k = min(4, len(np.unique(pixels, axis=0)))
    if k < 1:
        return None
    criteria = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 10, 1.0)
    _, labels, centers = cv2.kmeans(pixels, k, None, criteria, 3, cv2.KMEANS_PP_CENTERS)
    dom = centers[int(np.bincount(labels.flatten(), minlength=k).argmax())]

    bgr = cv2.cvtColor(dom.reshape(1, 1, 3), cv2.COLOR_Lab2BGR)
    b, g, r = (np.clip(bgr.reshape(3), 0, 1) * 255).astype(int)
    return FrameInfo((float(dom[0]), float(dom[1]), float(dom[2])),
                     (int(r), int(g), int(b)), f"#{r:02x}{g:02x}{b:02x}",
                     brightness, sharpness)


# --- Color-novelty index ---------------------------------------------------
class ColorIndex:
    def __init__(self, delta_e: float):
        self.delta_e = delta_e
        self.colors: list[tuple[tuple[float, float, float], str]] = []
        self.buckets: dict[tuple[int, int, int], list[int]] = {}

    def _key(self, lab):
        c = self.delta_e
        return (math.floor(lab[0] / c), math.floor(lab[1] / c), math.floor(lab[2] / c))

    def nearest(self, lab) -> float:
        ki, kj, kk = self._key(lab)
        best = math.inf
        for di in (-1, 0, 1):
            for dj in (-1, 0, 1):
                for dk in (-1, 0, 1):
                    for idx in self.buckets.get((ki + di, kj + dj, kk + dk), ()):
                        d = math.dist(lab, self.colors[idx][0])
                        if d < best:
                            best = d
        return best

    def add(self, lab, clip_id: str) -> None:
        idx = len(self.colors)
        self.colors.append((lab, clip_id))
        self.buckets.setdefault(self._key(lab), []).append(idx)

    def remove(self, clip_id: str) -> None:
        self.colors = [(lab, cid) for lab, cid in self.colors if cid != clip_id]
        self.reindex(self.delta_e)

    def reindex(self, delta_e: float) -> None:
        self.delta_e = delta_e
        self.buckets = {}
        for idx, (lab, _) in enumerate(self.colors):
            self.buckets.setdefault(self._key(lab), []).append(idx)

    @property
    def count(self) -> int:
        return len(self.colors)


# --- Clip extraction -------------------------------------------------------
def cut_clip(video_path: Path, start: float, duration: float, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = out_path.with_suffix(".tmp.mp4")
    result = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-ss", fmt_timestamp(start), "-i", str(video_path),
         "-t", f"{duration:.3f}",
         "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
         "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart", str(tmp)],
        capture_output=True, text=True,
    )
    if result.returncode != 0 or not tmp.exists():
        raise RuntimeError(f"ffmpeg clip failed:\n{result.stderr.strip()[-300:]}")
    tmp.replace(out_path)


# --- Discovery -------------------------------------------------------------
def search_video_ids(query: str, n: int) -> list[str]:
    r = subprocess.run(["yt-dlp", f"ytsearch{n}:{query}", "--flat-playlist",
                        "--print", "id", "--no-warnings"],
                       capture_output=True, text=True)
    if r.returncode != 0:
        print(f"  ! search failed for {query!r}: {r.stderr.strip()[-160:]}")
        return []
    return [ln.strip() for ln in r.stdout.splitlines() if ln.strip()]


def collect_candidates(args) -> list[tuple[str, str]]:
    """Return [(url, source_query), ...] deduped, from search + --urls + --seeds."""
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    queries = ([q.strip() for q in args.queries.split(",") if q.strip()]
               if args.queries else DEFAULT_QUERIES)
    for q in queries:
        ids = search_video_ids(q, args.per_query)
        print(f"  🔎 {q}: {len(ids)} hit(s)")
        for vid in ids:
            if vid not in seen:
                seen.add(vid)
                out.append((f"https://www.youtube.com/watch?v={vid}", q))
    for u in (args.urls or []):
        if u not in seen:
            seen.add(u)
            out.append((u, "manual"))
    if args.seeds and Path(args.seeds).exists():
        for ln in Path(args.seeds).read_text().splitlines():
            ln = ln.strip()
            if ln and not ln.startswith("#") and ln not in seen:
                seen.add(ln)
                out.append((ln, "seed"))
    print(f"  ✓ {len(out)} candidate video(s)")
    return out


# --- Shared run state ------------------------------------------------------
class State:
    def __init__(self, args):
        self.lock = threading.Lock()
        self.index = ColorIndex(args.delta_e)
        self.manifest = {"clips": []}
        self.videos: dict[str, dict] = {}      # video_id -> youtube_videos row
        self.used: set[tuple[str, int]] = set()
        self.seq: dict[str, int] = {}
        self.processed: set[str] = set()
        self.video_adds: list[int] = []        # new colors per finished video
        self.target = args.target
        self.floor = args.delta_floor
        self.last_save = 0.0

    def load(self):
        if CLIPS_JSON.exists() and CLIPS_JSON.stat().st_size:
            self.manifest = json.loads(CLIPS_JSON.read_text())
        for c in self.manifest["clips"]:
            self.index.add(tuple(c["color_lab"]), c["clip_id"])
            self.used.add((c["source_video"], c["end_seconds"]))
            self.seq[c["source_video"]] = max(self.seq.get(c["source_video"], 0),
                                              int(c["clip_id"].rsplit("_", 1)[1]))
        if VIDEOS_CSV.exists():
            with VIDEOS_CSV.open() as f:
                for row in csv.DictReader(f):
                    self.videos[row["video_id"]] = row
        if PROCESSED_TXT.exists():
            self.processed = {ln.strip() for ln in PROCESSED_TXT.read_text().splitlines()
                              if ln.strip()}

    def save(self, force=False):
        now = time.time()
        if not force and now - self.last_save < 3:
            return
        self.last_save = now
        CLIPS_JSON.write_text(json.dumps(self.manifest, indent=2, ensure_ascii=False) + "\n")
        hexes = {c["clip_id"]: c["color_hex"] for c in self.manifest["clips"]}
        COLORS_JSON.write_text(json.dumps({
            "delta_e": self.index.delta_e, "count": self.index.count,
            "colors": [{"clip_id": cid, "lab": [round(x, 2) for x in lab],
                        "hex": hexes.get(cid)} for lab, cid in self.index.colors],
        }, indent=2, ensure_ascii=False) + "\n")
        with VIDEOS_CSV.open("w", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["video_id", "title", "url",
                                              "source_query", "clips_count"])
            w.writeheader()
            for v in self.videos.values():
                w.writerow({k: v.get(k, "") for k in w.fieldnames})
        PROCESSED_TXT.parent.mkdir(parents=True, exist_ok=True)
        PROCESSED_TXT.write_text("\n".join(sorted(self.processed)) + "\n")


def hue_coverage(index: ColorIndex) -> int:
    """How many of 36 hue bins are occupied (a quick spectrum-spread gauge)."""
    bins = set()
    for lab, _ in index.colors:
        L, a, b = lab
        bins.add(int((math.degrees(math.atan2(b, a)) % 360) // 10))
    return len(bins)


# --- Per-video processing --------------------------------------------------
def download_video(url: str, args) -> tuple[str, str, Path]:
    """yt-dlp download with optional browser cookies + polite rate limiting.

    Local to this script (main.py's version stays cookie-free) so we can
    authenticate past YouTube's bot wall and throttle to avoid re-tripping it.
    """
    VIDEOS_DIR.mkdir(parents=True, exist_ok=True)
    cmd = ["yt-dlp",
           "-f", "bv*+ba/b",            # client-agnostic; merged to mp4 below
           "--merge-output-format", "mp4",
           "-o", str(VIDEOS_DIR / "%(id)s.%(ext)s"),
           "--print", "after_move:%(id)s\t%(title)s\t%(filepath)s",
           "--no-simulate", "--no-progress", "--no-warnings", "--retries", "3"]
    if args.player_clients:
        # tv_embedded/web_safari still serve real formats from a flagged IP,
        # where the default/ios/android clients get storyboard-only responses.
        cmd += ["--extractor-args", f"youtube:player_client={args.player_clients}"]
    if args.cookies_from_browser:
        cmd += ["--cookies-from-browser", args.cookies_from_browser]
    if args.cookies:
        cmd += ["--cookies", args.cookies]
    if args.sleep_requests:
        cmd += ["--sleep-requests", str(args.sleep_requests)]
    if args.sleep_interval:
        cmd += ["--sleep-interval", str(args.sleep_interval),
                "--max-sleep-interval", str(args.sleep_interval * 2)]
    cmd.append(url)
    # A flagged IP intermittently gets storyboard-only responses ("Requested
    # format is not available") even when cookies + client are correct — the JS
    # challenge is nondeterministic. Retry the whole extraction a few times; a
    # later attempt usually lands a good response.
    last = ""
    for attempt in range(5):
        result = subprocess.run(cmd, capture_output=True, text=True)
        if result.returncode == 0:
            lines = [ln for ln in result.stdout.splitlines() if "\t" in ln]
            if lines:
                video_id, title, filepath = lines[-1].split("\t", 2)
                return video_id, title, Path(filepath)
        last = (result.stderr or result.stdout).strip()[-200:]
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(last)


def url_video_id(url: str) -> str | None:
    """Best-effort YouTube id from a watch URL, to skip re-downloads cheaply."""
    import re
    m = re.search(r"[?&]v=([A-Za-z0-9_-]{11})", url) or re.search(r"/([A-Za-z0-9_-]{11})$", url)
    return m.group(1) if m else None


def process_video(url: str, src_query: str, state: State, args, sb,
                  local_path: Path | None = None) -> int:
    # Local mode: a video the user dropped in (no download; never deleted).
    if local_path is not None:
        video_id, title, path = local_path.stem, local_path.stem, local_path
        url = f"local:{video_id}"
        with state.lock:
            if video_id in state.processed and not getattr(args, "reprocess", False):
                return 0
    else:
        pre_id = url_video_id(url)
        if pre_id:
            with state.lock:
                if pre_id in state.processed:
                    return 0
        try:
            video_id, title, path = download_video(url, args)
        except Exception as e:  # noqa: BLE001
            print(f"  ✗ download failed {url}: {str(e)[-160:]}")
            return 0
        with state.lock:
            if video_id in state.processed:
                return 0
    try:
        frames = sample_frames(video_id, path, 1.0)
    except Exception as e:  # noqa: BLE001
        print(f"  ✗ sample failed {video_id}: {str(e)[-160:]}")
        return 0

    added = 0
    for sec, fpath in frames:
        with state.lock:
            if state.index.count >= state.target:
                break
            delta = state.index.delta_e
        if sec < args.max_len:
            continue
        with state.lock:
            if (video_id, sec) in state.used:
                continue
        info = analyze_frame(fpath)
        if info is None or info.brightness < args.min_bright or info.sharpness < args.min_sharp:
            continue

        # Reserve the color atomically, then do the heavy ffmpeg work unlocked.
        with state.lock:
            if state.index.count >= state.target:
                break
            if state.index.nearest(info.lab) < state.index.delta_e:
                continue
            state.seq[video_id] = state.seq.get(video_id, 0) + 1
            clip_id = f"{video_id}_{state.seq[video_id]:03d}"
            state.index.add(info.lab, clip_id)
            state.used.add((video_id, sec))

        dur = random.uniform(args.min_len, args.max_len)
        start = max(0.0, sec - dur)
        dur = sec - start
        clip_file = CLIPS_DIR / f"{clip_id}.mp4"
        frame_file = CLIPFRAMES_DIR / f"{clip_id}.jpg"
        try:
            cut_clip(path, start, dur, clip_file)
            capture_frame(path, sec, frame_file)
        except RuntimeError as e:
            print(f"    ! {e}")
            with state.lock:
                state.index.remove(clip_id)
                state.seq[video_id] -= 1
            continue

        r, g, b = info.rgb
        record = {
            "clip_id": clip_id, "source_video": video_id, "url": url, "title": title,
            "end_seconds": sec, "end_timestamp": fmt_timestamp(sec),
            "clip_start": fmt_timestamp(start), "duration": round(dur, 1),
            "color_hex": info.hex, "color_rgb": [r, g, b],
            "color_lab": list(info.lab),
            "clip_file": str(clip_file.relative_to(SCRIPT_DIR)),
            "frame_file": str(frame_file.relative_to(SCRIPT_DIR)),
        }
        with state.lock:
            state.manifest["clips"].append(record)
            added += 1
            count = state.index.count
            state.save()
        print(f"    {clip_id}  {fmt_timestamp(sec)}  {info.hex}  rgb{tuple(info.rgb)}  "
              f"[{count}/{state.target}]")

        # Publish best-effort (never blocks color finding).
        if sb and sb.enabled:
            sb.upsert("clips", [{
                "clip_id": clip_id, "source_video": video_id, "url": url, "title": title,
                "end_seconds": sec, "end_timestamp": fmt_timestamp(sec),
                "clip_start": fmt_timestamp(start), "duration": round(dur, 1),
                "color_hex": info.hex, "r": r, "g": g, "b": b,
                "lab_l": round(info.lab[0], 2), "lab_a": round(info.lab[1], 2),
                "lab_b": round(info.lab[2], 2),
                "clip_path": f"clips/{clip_id}.mp4", "frame_path": f"frames/{clip_id}.jpg",
            }], on_conflict="clip_id")
            sb.upload_file(f"frames/{clip_id}.jpg", frame_file, "image/jpeg")
            if args.upload_clips:
                sb.upload_file(f"clips/{clip_id}.mp4", clip_file, "video/mp4")

    # Record the video, publish it, drop the big source file.
    with state.lock:
        state.videos[video_id] = {"video_id": video_id, "title": title, "url": url,
                                  "source_query": src_query, "clips_count": added}
        state.processed.add(video_id)
        state.video_adds.append(added)
        state.save(force=True)
    if sb and sb.enabled:
        sb.upsert("youtube_videos", [{"video_id": video_id, "title": title, "url": url,
                                      "source_query": src_query, "clips_count": added}],
                  on_conflict="video_id")
    if not args.keep_videos and local_path is None:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
    print(f"  ✓ {video_id} — {title[:60]} (+{added} colors, {state.index.count}/{state.target})")
    return added


# --- Orchestration ---------------------------------------------------------
def run(args, state: State, sb, candidates):
    stop = threading.Event()

    def worker(item):
        if stop.is_set():
            return
        if isinstance(item, Path):          # local mode: item is an mp4 path
            process_video(None, "local", state, args, sb, local_path=item)
        else:
            url, q = item
            process_video(url, q, state, args, sb)
        with state.lock:
            if state.index.count >= state.target:
                stop.set()

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(worker, item) for item in candidates]
        last_report = time.time()
        last_lower_at = 0
        while True:
            done = sum(f.done() for f in futures)
            with state.lock:
                count = state.index.count
                n_videos = len(state.video_adds)
            if count >= state.target or done == len(futures):
                break
            # Adaptive: if recent videos are barely adding colors, tighten ΔE.
            if (count < state.target and n_videos - last_lower_at >= 6
                    and sum(state.video_adds[-6:]) < 6
                    and state.index.delta_e > state.floor):
                with state.lock:
                    new_de = max(state.floor, state.index.delta_e * 0.8)
                    state.index.reindex(new_de)
                last_lower_at = n_videos
                print(f"  ⟳ adaptive: ΔE -> {new_de:.1f} (stalled at {count}/{state.target})")
            if time.time() - last_report > 20:
                last_report = time.time()
                print(f"  … {count}/{state.target} colors | {done}/{len(futures)} videos "
                      f"| ΔE {state.index.delta_e:.1f} | hue {hue_coverage(state.index)}/36")
            time.sleep(2)
        stop.set()
        for f in futures:
            f.cancel()
    state.save(force=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--target", type=int, default=500)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--cookies-from-browser", default=None,
                        help="e.g. chrome/safari/firefox — auth past YouTube's bot wall")
    parser.add_argument("--player-clients", default="tv_embedded,web_safari,default",
                        help="yt-dlp youtube player_client order (dodges storyboard-only throttle)")
    parser.add_argument("--cookies", default=None, help="path to a cookies.txt file")
    parser.add_argument("--sleep-requests", type=float, default=1.0,
                        help="yt-dlp --sleep-requests (politeness between API calls)")
    parser.add_argument("--sleep-interval", type=float, default=3.0,
                        help="yt-dlp min sleep before each download (max = 2x)")
    parser.add_argument("--queries", default=None)
    parser.add_argument("--per-query", type=int, default=40)
    parser.add_argument("--urls", nargs="*", default=[])
    parser.add_argument("--seeds", default=None)
    parser.add_argument("--delta-e", type=float, default=12.0)
    parser.add_argument("--delta-floor", type=float, default=4.0,
                        help="lowest ΔE the adaptive loop will tighten to")
    parser.add_argument("--min-len", type=float, default=15.0)
    parser.add_argument("--max-len", type=float, default=20.0)
    parser.add_argument("--min-bright", type=float, default=25.0)
    parser.add_argument("--min-sharp", type=float, default=15.0)
    parser.add_argument("--keep-videos", action="store_true",
                        help="don't delete source mp4s after processing")
    parser.add_argument("--upload-clips", action="store_true", default=True,
                        help="upload clip mp4s to Supabase storage (default on)")
    parser.add_argument("--no-upload-clips", action="store_false", dest="upload_clips")
    parser.add_argument("--no-supabase", action="store_true")
    parser.add_argument("--local", action="store_true",
                        help="process mp4s already in the videos dir (no YouTube download)")
    parser.add_argument("--videos-dir", default=None,
                        help="folder of mp4s for --local (default pipeline/videos)")
    parser.add_argument("--reprocess", action="store_true",
                        help="re-scan already-processed videos (mine more colors at lower --delta-e)")
    args = parser.parse_args()

    CLIPS_DIR.mkdir(parents=True, exist_ok=True)
    CLIPFRAMES_DIR.mkdir(parents=True, exist_ok=True)

    sb = None if args.no_supabase else supabase_push.client()
    if sb and sb.enabled:
        sb.ensure_bucket()

    state = State(args)
    state.load()
    print(f"▶ start: {state.index.count} clip(s) already collected, target {state.target}")

    if args.local:
        vdir = Path(args.videos_dir) if args.videos_dir else VIDEOS_DIR
        candidates = sorted(vdir.glob("*.mp4"))
        args.keep_videos = True             # never delete the user's own files
        if not args.reprocess:
            candidates = [p for p in candidates if p.stem not in state.processed]
        print(f"  📁 local mode: {len(candidates)} mp4(s) to scan in {vdir.name}/ "
              f"(ΔE {args.delta_e}{', reprocess' if args.reprocess else ''})")
    else:
        candidates = collect_candidates(args)

    if candidates and state.index.count < state.target:
        run(args, state, sb, candidates)

    print(f"\n✓ done — {state.index.count} diverse clips | "
          f"hue {hue_coverage(state.index)}/36 bins | {len(state.videos)} videos")
    if state.index.count < state.target:
        print(f"  note: gamut yielded {state.index.count} < {state.target}. Re-run to "
              f"pull more videos, or lower --delta-floor to keep tightening.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
