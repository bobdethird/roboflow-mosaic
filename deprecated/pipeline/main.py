#!/usr/bin/env python3
"""YouTube basketball video -> iconic key-frame pipeline (fast, parallel).

Instead of uploading whole videos, we sample cheaply and fan out to Gemini in
parallel so runtime stays roughly flat regardless of video length:

  1. DOWNLOAD  yt-dlp pulls the video into videos/<videoId>.mp4
  2. SAMPLE    ffmpeg decodes it to 1 frame per second at 640px (low token cost)
  3. LABEL     frames are grouped into batches of 10 and sent to Gemini IN
               PARALLEL; the model flags which frames are the RESULT of a key
               play (dunk finish, made three, secured steal, block, eruption)
               with a play type, description, and 1-10 hype score
  4. SELECT    adjacent key seconds belonging to the same play are merged and
               the single peak frame is kept, so every play yields one photo
  5. CAPTURE   ffmpeg re-extracts a full-resolution, high-quality JPG at each
               kept timestamp into key-frames/<videoId>_<NNN>.jpg
  6. RECORD    video.json maps every video to its key frames

Usage:
  pip install -r requirements.txt          # yt-dlp + ffmpeg must be on PATH
  export GEMINI_API_KEY=...                 # or put it in ../.env
  python main.py <youtube_url> [<youtube_url> ...]

Options:
  --model        Gemini model (default: gemini-2.5-flash)
  --fps          frames sampled per second (default: 1)
  --batch        frames per Gemini request (default: 10)
  --workers      parallel Gemini requests in flight (default: 16)
  --min-score    drop key frames below this hype score 1-10 (default: 5)
  --merge-gap    merge key seconds within this many seconds into one play (default: 2)
  --force        re-analyze even if the video is already in video.json
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from dotenv import load_dotenv
from google import genai
from google.genai import types
from pydantic import BaseModel

# --- Paths -----------------------------------------------------------------
SCRIPT_DIR = Path(__file__).resolve().parent
VIDEOS_DIR = SCRIPT_DIR / "videos"
KEYFRAMES_DIR = SCRIPT_DIR / "key-frames"
VIDEO_JSON = SCRIPT_DIR / "video.json"
CACHE_DIR = SCRIPT_DIR / ".cache" / "frames"   # sampled low-res frames per video

# .env lives at the repo root (one level up); load it without overriding a
# value already exported in the shell.
load_dotenv(SCRIPT_DIR.parent / ".env")

DEFAULT_MODEL = "gemini-2.5-flash"
SAMPLE_WIDTH = 640   # long-edge px for the cheap analysis frames

# One prompt per batch. The frames are tagged with their timestamps in the
# interleaved content, so the model can reference them precisely.
BATCH_PROMPT = """\
You are labeling frames sampled at {fps} fps from a basketball video. Each image
is tagged in the text right before it as [t=<seconds>s].

Return an entry ONLY for frames that capture the RESULT / peak of a genuine key
play — the moment the decisive action has just happened, not the wind-up:
  - dunk      -> ball being slammed through / hanging on the rim
  - three / big shot -> ball dropping through the net (a made shot)
  - steal     -> defender securing the ball or breaking the other way
  - block     -> hand meeting ball / the ball getting swatted
  - poster / crossover / ankle-breaker at its peak
  - buzzer-beater or clutch bucket
  - a big crowd or bench eruption right after a play

Skip everything routine: dribbling up the court, dead balls, free throws,
timeouts, standing around, and blurry transition frames. When a play spans
several consecutive frames, return the SINGLE best frame (the clearest peak).

For each kept frame return: timestamp_seconds (exactly matching its [t=...] tag),
play_type, a short description, and hype_score (1-10, how iconic the frame is).
If none of these frames qualify, return an empty list.
"""


class KeyFrame(BaseModel):
    timestamp_seconds: int
    play_type: str       # "dunk", "three", "steal", "block", "celebration", ...
    description: str      # one short sentence
    hype_score: int       # 1-10, how iconic / wall-worthy the frame is


# --- Step 1: download ------------------------------------------------------
def download_video(url: str) -> tuple[str, str, Path]:
    """Download `url` with yt-dlp. Returns (video_id, title, file_path)."""
    VIDEOS_DIR.mkdir(parents=True, exist_ok=True)
    print(f"  ↓ downloading {url}")
    result = subprocess.run(
        [
            "yt-dlp",
            "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best",
            "--merge-output-format", "mp4",
            "-o", str(VIDEOS_DIR / "%(id)s.%(ext)s"),
            "--print", "after_move:%(id)s\t%(title)s\t%(filepath)s",
            "--no-simulate",
            "--no-progress",
            url,
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        raise RuntimeError(f"yt-dlp failed for {url}:\n{result.stderr.strip()}")

    line = [ln for ln in result.stdout.splitlines() if "\t" in ln][-1]
    video_id, title, filepath = line.split("\t", 2)
    print(f"  ✓ {video_id} — {title}")
    return video_id, title, Path(filepath)


# --- Step 2: sample 1fps low-res frames ------------------------------------
def sample_frames(video_id: str, path: Path, fps: float) -> list[tuple[int, Path]]:
    """Decode the video to `fps` frames/sec at SAMPLE_WIDTH px.

    Returns [(timestamp_seconds, frame_path), ...] in order. Cached per video so
    reruns skip the decode.
    """
    out_dir = CACHE_DIR / video_id
    out_dir.mkdir(parents=True, exist_ok=True)
    existing = sorted(out_dir.glob("t*.jpg"))
    if not existing:
        print(f"  ⛏ sampling frames ({fps}fps, {SAMPLE_WIDTH}px)")
        result = subprocess.run(
            [
                "ffmpeg", "-y", "-i", str(path),
                "-vf", f"fps={fps},scale='min({SAMPLE_WIDTH},iw)':-2",
                "-q:v", "5",
                str(out_dir / "t%06d.jpg"),
            ],
            capture_output=True, text=True,
        )
        if result.returncode != 0:
            raise RuntimeError(f"ffmpeg sampling failed:\n{result.stderr.strip()[-400:]}")
        existing = sorted(out_dir.glob("t*.jpg"))

    # Frame k (1-based) from fps=1 corresponds to second k-1.
    step = 1.0 / fps
    frames = [(int(round((i) * step)), p) for i, p in enumerate(existing)]
    print(f"  ✓ {len(frames)} frames sampled")
    return frames


# --- Step 3: label frames in parallel batches ------------------------------
def label_batch(client: genai.Client, model: str, fps: float,
                batch: list[tuple[int, Path]]) -> list[KeyFrame]:
    """Send one batch of (timestamp, frame_path) to Gemini; return key frames."""
    parts: list[types.Part] = [types.Part.from_text(text=BATCH_PROMPT.format(fps=fps))]
    for ts, fpath in batch:
        parts.append(types.Part.from_text(text=f"[t={ts}s]"))
        parts.append(types.Part.from_bytes(data=fpath.read_bytes(), mime_type="image/jpeg"))

    last_err: Exception | None = None
    for attempt in range(4):  # small retry for transient errors / rate limits
        try:
            response = client.models.generate_content(
                model=model,
                contents=parts,
                config=types.GenerateContentConfig(
                    response_mime_type="application/json",
                    response_schema=list[KeyFrame],
                ),
            )
            return response.parsed or []
        except Exception as e:  # noqa: BLE001 - retry then surface
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"batch failed after retries: {last_err}")


def label_all(client: genai.Client, model: str, fps: float,
              frames: list[tuple[int, Path]], batch_size: int,
              workers: int) -> list[KeyFrame]:
    """Fan all batches out to Gemini in parallel and collect key frames."""
    batches = [frames[i:i + batch_size] for i in range(0, len(frames), batch_size)]
    print(f"  ⇄ {len(batches)} batches × ≤{batch_size} frames, {workers} in parallel")

    key_frames: list[KeyFrame] = []
    done = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(label_batch, client, model, fps, b): b for b in batches}
        for fut in as_completed(futures):
            done += 1
            try:
                key_frames.extend(fut.result())
            except Exception as e:  # noqa: BLE001
                print(f"    ! batch error: {e}")
            print(f"    …{done}/{len(batches)} batches", end="\r", flush=True)
    print()
    return key_frames


# --- Step 4: merge adjacent key seconds into distinct plays ----------------
def select_plays(key_frames: list[KeyFrame], min_score: int,
                 merge_gap: int) -> list[KeyFrame]:
    """Dedup: collapse runs of nearby key seconds into one peak frame per play."""
    kept = sorted((k for k in key_frames if k.hype_score >= min_score),
                  key=lambda k: k.timestamp_seconds)
    plays: list[KeyFrame] = []
    run: list[KeyFrame] = []
    for kf in kept:
        if run and kf.timestamp_seconds - run[-1].timestamp_seconds > merge_gap:
            plays.append(max(run, key=lambda k: k.hype_score))
            run = []
        run.append(kf)
    if run:
        plays.append(max(run, key=lambda k: k.hype_score))
    return plays


# --- Step 5: capture full-res frames ---------------------------------------
def fmt_timestamp(seconds: float) -> str:
    """Seconds -> HH:MM:SS.mmm for ffmpeg seeking and human-readable json."""
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}.{ms:03d}"


def capture_frame(video_path: Path, seconds: float, out_path: Path) -> None:
    """Extract one full-res, high-quality JPG at `seconds` via ffmpeg."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [
            "ffmpeg", "-y",
            "-ss", fmt_timestamp(seconds),
            "-i", str(video_path),
            "-frames:v", "1",
            "-q:v", "2",                       # JPEG quality ~95
            str(out_path),
        ],
        capture_output=True, text=True,
    )
    if result.returncode != 0 or not out_path.exists():
        raise RuntimeError(
            f"ffmpeg failed to capture {out_path.name}:\n{result.stderr.strip()[-400:]}"
        )


# --- video.json I/O --------------------------------------------------------
def load_manifest() -> dict:
    if VIDEO_JSON.exists() and VIDEO_JSON.stat().st_size > 0:
        return json.loads(VIDEO_JSON.read_text())
    return {"videos": {}}


def save_manifest(manifest: dict) -> None:
    VIDEO_JSON.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")


# --- Orchestration ---------------------------------------------------------
def process(url: str, client: genai.Client, args, manifest: dict) -> None:
    t0 = time.time()
    video_id, title, path = download_video(url)

    if video_id in manifest["videos"] and not args.force:
        print(f"  • {video_id} already in video.json — skipping (use --force)\n")
        return

    frames = sample_frames(video_id, path, args.fps)
    key_frames = label_all(client, args.model, args.fps, frames, args.batch, args.workers)
    plays = select_plays(key_frames, args.min_score, args.merge_gap)
    print(f"  ★ {len(plays)} key play(s) from {len(key_frames)} flagged frames")

    records = []
    for i, kf in enumerate(plays, start=1):
        photo_id = f"{video_id}_{i:03d}"
        out_path = KEYFRAMES_DIR / f"{photo_id}.jpg"
        try:
            capture_frame(path, kf.timestamp_seconds, out_path)
        except RuntimeError as e:
            print(f"    ! {e}")
            continue
        print(f"    {photo_id}  {fmt_timestamp(kf.timestamp_seconds)}  "
              f"[{kf.play_type}] {kf.description}")
        records.append({
            "photo_id": photo_id,
            "timestamp": fmt_timestamp(kf.timestamp_seconds),
            "seconds": kf.timestamp_seconds,
            "play_type": kf.play_type,
            "description": kf.description,
            "hype_score": kf.hype_score,
            "file": str(out_path.relative_to(SCRIPT_DIR)),
        })

    manifest["videos"][video_id] = {
        "url": url,
        "title": title,
        "video_file": str(path.relative_to(SCRIPT_DIR)),
        "key_frames": records,
    }
    save_manifest(manifest)
    print(f"  ✓ video.json updated — {len(records)} frames in {time.time() - t0:.1f}s\n")


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("urls", nargs="+", help="YouTube video URL(s)")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--fps", type=float, default=1.0)
    parser.add_argument("--batch", type=int, default=10)
    parser.add_argument("--workers", type=int, default=16)
    parser.add_argument("--min-score", type=int, default=5,
                        help="drop key frames below this hype score 1-10")
    parser.add_argument("--merge-gap", type=int, default=2,
                        help="merge key seconds within this many seconds into one play")
    parser.add_argument("--force", action="store_true",
                        help="re-analyze even if already in video.json")
    args = parser.parse_args()

    client = genai.Client()  # reads GEMINI_API_KEY / GOOGLE_API_KEY from env
    manifest = load_manifest()

    for url in args.urls:
        print(f"▶ {url}")
        try:
            process(url, client, args, manifest)
        except Exception as e:  # noqa: BLE001
            print(f"  ✗ failed: {e}\n")

    return 0


if __name__ == "__main__":
    sys.exit(main())
