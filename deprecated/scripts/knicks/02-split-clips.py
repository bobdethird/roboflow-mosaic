#!/usr/bin/env python3
"""Split source videos into clips from manually-marked timestamps.

Input is data/clip-marks.csv with rows of `video link,end time`. Each row marks
the END of a clip; the clip's start is where the previous row's clip ended
(0:00 for the first row of a video). Rows whose end time is the literal string
"chapter" mean "use the video's YouTube chapters as clip boundaries" instead.

Spreadsheet autofill can corrupt repeated video IDs by incrementing a trailing
number (Jsj8Lyi1Pi4, Jsj8Lyi1Pi5, ...). Consecutive rows whose IDs share the
same non-numeric stem are collapsed onto the first row's ID.

Cut mode is chosen per video:
  - manual-marked videos get frame-accurate cuts via re-encode, honoring the
    hand-picked timestamps exactly;
  - chapter videos get keyframe-snapped lossless stream copies (spans snap
    OUTWARD: start back / end forward to the nearest keyframe, so clips only
    ever gain footage at the edges, never lose any) — chapter boundaries are
    coarse anyway and the footage is hours long.
Override with --reencode-all or --copy-all.

Outputs:
  data/clips/<videoId>/<nnn>_<start>-<end>.mp4
  data/clips.json                                (manifest)

Usage:
  python3 scripts/knicks/02-split-clips.py [--csv PATH] [--force] [--dry-run]
"""

import argparse
import bisect
import csv
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR / "data"
VIDEOS_DIR = DATA_DIR / "videos"
METADATA_DIR = DATA_DIR / "metadata"
CLIPS_DIR = DATA_DIR / "clips"
MANIFEST_PATH = DATA_DIR / "clips.json"

VIDEO_ID_RE = re.compile(r"^[\w-]{11}$")


def video_id_from_url(value: str):
    value = value.strip()
    if VIDEO_ID_RE.match(value):
        return value
    m = re.search(r"[?&]v=([\w-]+)", value)
    if m:
        return m.group(1)
    m = re.search(r"youtu\.be/([\w-]+)", value)
    return m.group(1) if m else None


def parse_timestamp(value: str):
    parts = value.strip().split(":")
    if not all(p.strip().isdigit() for p in parts) or len(parts) not in (2, 3):
        return None
    parts = [int(p) for p in parts]
    if len(parts) == 2:
        return parts[0] * 60 + parts[1]
    return parts[0] * 3600 + parts[1] * 60 + parts[2]


def id_stem(video_id: str):
    return re.sub(r"\d+$", "", video_id)


def load_marks(csv_path: Path):
    """Parse the CSV into ordered per-video blocks of end-time marks."""
    blocks = []  # [{id, mode: "marks"|"chapters", ends: [sec]}]
    current = None
    with csv_path.open(newline="") as f:
        reader = csv.reader(f)
        for i, row in enumerate(reader):
            if not row or not row[0].strip():
                continue
            if i == 0 and "link" in row[0].lower():
                continue
            raw_id = video_id_from_url(row[0])
            if not raw_id:
                print(f"  warn: row {i + 1}: cannot parse video id from {row[0]!r}, skipping")
                continue
            end_raw = (row[1] if len(row) > 1 else "").strip().lower()

            if current is None or id_stem(raw_id) != id_stem(current["id"]):
                current = {"id": raw_id, "mode": None, "ends": []}
                blocks.append(current)
            elif raw_id != current["id"] and not current.get("warned_autofill"):
                print(
                    f"  note: collapsing autofill-corrupted ids "
                    f"({current['id']} … {raw_id}) onto {current['id']}"
                )
                current["warned_autofill"] = True

            if end_raw == "chapter":
                current["mode"] = "chapters"
                continue

            sec = parse_timestamp(end_raw)
            if sec is None:
                print(f"  warn: row {i + 1}: bad end time {end_raw!r}, skipping")
                continue
            current["mode"] = current["mode"] or "marks"
            current["ends"].append(sec)

    for block in blocks:
        if not VIDEO_ID_RE.match(block["id"]):
            sys.exit(f"error: {block['id']!r} is not a valid YouTube video id")
    return blocks


def load_metadata(video_id: str):
    path = METADATA_DIR / f"{video_id}.json"
    if path.exists():
        with path.open() as f:
            return json.load(f)
    return {}


def ffprobe_duration(path: Path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return float(out)


def probe_keyframes(path: Path):
    """Return sorted pts (seconds) of all video keyframes. Demux-only, no decode."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    keyframes = []
    for line in out.splitlines():
        parts = line.split(",")
        if len(parts) >= 2 and "K" in parts[1] and parts[0] not in ("N/A", ""):
            keyframes.append(float(parts[0]))
    keyframes.sort()
    return keyframes


def snap_outward(start, end, keyframes, duration):
    """Snap start back and end forward to the nearest keyframes."""
    if not keyframes:
        return start, end
    i = bisect.bisect_right(keyframes, start + 1e-3) - 1
    snapped_start = keyframes[i] if i >= 0 else 0.0
    j = bisect.bisect_left(keyframes, end - 1e-3)
    snapped_end = keyframes[j] if j < len(keyframes) else duration
    return snapped_start, max(snapped_end, end)


def build_clips(blocks, mode_override=None):
    """Resolve each block into concrete (start, end) clip spans."""
    clips = []
    for block in blocks:
        vid = block["id"]
        video_path = VIDEOS_DIR / f"{vid}.mp4"
        if not video_path.exists():
            sys.exit(f"error: missing source video {video_path} — download it first")
        meta = load_metadata(vid)
        duration = float(meta.get("duration") or ffprobe_duration(video_path))

        if block["mode"] == "chapters":
            chapters = meta.get("chapters") or []
            if not chapters:
                sys.exit(f"error: {vid} marked 'chapter' but its metadata has no chapters")
            spans = [
                (float(c["start_time"]), min(float(c["end_time"]), duration), "chapter")
                for c in chapters
            ]
        else:
            spans = []
            prev = 0.0
            for end in block["ends"]:
                end = float(end)
                if end <= prev:
                    if end == prev:
                        print(f"  note: {vid}: duplicate mark at {end:.0f}s, skipping")
                    else:
                        print(f"  warn: {vid}: non-increasing mark {end:.0f}s after {prev:.0f}s, skipping")
                    continue
                if end > duration + 1:
                    print(f"  warn: {vid}: mark {end:.0f}s beyond video end ({duration:.0f}s), clamping")
                    end = duration
                spans.append((prev, end, "manual"))
                prev = end

        cut = mode_override or ("copy" if block["mode"] == "chapters" else "reencode")

        keyframes = None
        if cut == "copy":
            print(f"  probing keyframes for {vid}…", flush=True)
            keyframes = probe_keyframes(video_path)
            if keyframes:
                gaps = [b - a for a, b in zip(keyframes, keyframes[1:])]
                print(
                    f"    {len(keyframes)} keyframes, median gap "
                    f"{sorted(gaps)[len(gaps) // 2]:.1f}s"
                )

        for idx, (start, end, source) in enumerate(spans):
            marked = {"start": round(start, 3), "end": round(end, 3)}
            if cut == "copy":
                start, end = snap_outward(start, end, keyframes, duration)
            clips.append({
                "videoId": vid,
                "videoPath": str(video_path),
                "index": idx,
                "start": round(start, 3),
                "end": round(min(end, duration), 3),
                "duration": round(min(end, duration) - start, 3),
                "marked": marked,
                "boundarySource": source,
                "cut": cut,
            })
    return clips


def clip_output_path(clip):
    name = f"{clip['index']:03d}_{int(clip['start'])}-{int(clip['end'])}.mp4"
    return CLIPS_DIR / clip["videoId"] / name


def extract_clip(clip, force: bool):
    out_path = clip_output_path(clip)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.exists() and not force:
        return clip, "skipped"
    tmp_path = out_path.with_suffix(".tmp.mp4")
    if clip["cut"] == "reencode":
        codec_args = [
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-c:a", "aac", "-b:a", "128k",
        ]
    else:
        codec_args = ["-c", "copy", "-avoid_negative_ts", "make_zero"]
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-ss", f"{clip['start']:.3f}",
        "-i", clip["videoPath"],
        "-t", f"{clip['duration']:.3f}",
        *codec_args,
        "-movflags", "+faststart",
        str(tmp_path),
    ]
    subprocess.run(cmd, check=True)
    tmp_path.rename(out_path)
    return clip, "encoded" if clip["cut"] == "reencode" else "copied"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--csv", type=Path, default=DATA_DIR / "clip-marks.csv")
    parser.add_argument("--force", action="store_true", help="rebuild existing clips")
    parser.add_argument("--dry-run", action="store_true", help="print the plan, don't cut")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--reencode-all", action="store_true",
        help="frame-accurate re-encode for every video, including chapter videos",
    )
    mode.add_argument(
        "--copy-all", action="store_true",
        help="keyframe-snapped stream copy for every video, including manual marks",
    )
    parser.add_argument(
        "--jobs", type=int,
        default=max(1, (os.cpu_count() or 4) // 2),
        help="parallel ffmpeg jobs",
    )
    args = parser.parse_args()

    mode_override = (
        "reencode" if args.reencode_all else "copy" if args.copy_all else None
    )
    blocks = load_marks(args.csv)
    clips = build_clips(blocks, mode_override=mode_override)

    by_video = {}
    for clip in clips:
        by_video.setdefault(clip["videoId"], []).append(clip)
    total_sec = sum(c["duration"] for c in clips)
    print(f"Plan: {len(clips)} clips from {len(by_video)} videos ({total_sec / 60:.1f} min of footage)")
    for vid, vclips in by_video.items():
        durs = [c["duration"] for c in vclips]
        print(
            f"  {vid}: {len(vclips)} clips, {min(durs):.0f}-{max(durs):.0f}s each "
            f"({vclips[0]['boundarySource']}, {vclips[0]['cut']})"
        )

    if args.dry_run:
        for clip in clips:
            print(f"  {clip['videoId']} #{clip['index']:03d}: {clip['start']:.0f}s → {clip['end']:.0f}s")
        return

    # Clear stale clip dirs for the videos being (re)built so old boundaries
    # never linger next to new ones.
    for vid in by_video:
        vdir = CLIPS_DIR / vid
        if vdir.exists():
            expected = {clip_output_path(c).name for c in by_video[vid]}
            for f in vdir.iterdir():
                if f.name not in expected:
                    f.unlink() if f.is_file() else shutil.rmtree(f)

    done = 0
    failures = []
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = {
            pool.submit(extract_clip, clip, args.force): clip for clip in clips
        }
        for future in as_completed(futures):
            clip = futures[future]
            try:
                _, status = future.result()
            except subprocess.CalledProcessError as err:
                failures.append((clip, err))
                print(f"  FAILED {clip['videoId']} #{clip['index']:03d}: {err}")
                continue
            done += 1
            print(
                f"  [{done}/{len(clips)}] {clip['videoId']} #{clip['index']:03d} "
                f"{clip['start']:.0f}-{clip['end']:.0f}s ({status})"
            )

    manifest = {
        "generatedAt": datetime.datetime.now().astimezone().isoformat(),
        "source": str(args.csv),
        "clips": [
            {**clip, "path": str(clip_output_path(clip))}
            for clip in clips
        ],
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Wrote manifest with {len(clips)} clips to {MANIFEST_PATH}")
    if failures:
        sys.exit(f"{len(failures)} clip(s) failed to encode")


if __name__ == "__main__":
    main()
