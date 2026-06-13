#!/usr/bin/env python3
"""Step 3: prepare cached tile clip frame sequences.

Reads `data/matches/grid-plan.json` from Step 2 and creates one cached frame
sequence per distinct matched frame. The animated pre-roll is extracted near the
matched timestamp, and the final frame is always the exact indexed frame:

    ffmpeg -i <video> -vf "fps=<sample_fps>,select='eq(n\\,<frameIndex>)',..."

That final-frame invariant is the important part: render/freeze logic can use
the last frame in each sequence without reintroducing timestamp-seek mismatch.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any


PIPELINE_ROOT = Path(__file__).resolve().parent
DATA_DIR = PIPELINE_ROOT / "data"
DEFAULT_PLAN_PATH = DATA_DIR / "matches" / "grid-plan.json"
CLIP_CACHE_DIR = DATA_DIR / "clip-cache"
CLIPS_MANIFEST_PATH = DATA_DIR / "clips.json"


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(PIPELINE_ROOT.resolve()).as_posix()
    except ValueError:
        return str(path)


def short_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def read_json(path: Path) -> Any:
    return json.loads(path.read_text())


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")


def run(command: list[str]) -> None:
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        rendered = " ".join(command[:8] + ["..."])
        detail = result.stderr.strip() or result.stdout.strip() or "no ffmpeg output"
        raise RuntimeError(f"{rendered} failed ({result.returncode}): {detail[:1200]}")


def frame_list(cache_dir: Path) -> list[Path]:
    return sorted(cache_dir.glob("frame_*.jpg"))


def ffmpeg_time(seconds: float) -> str:
    return f"{max(0.0, seconds):.6f}"


def cover_filter(width: int, height: int) -> str:
    return ",".join(
        [
            f"scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos",
            f"crop={width}:{height}",
            "setsar=1",
        ]
    )


def source_path_for(frame: dict[str, Any]) -> Path:
    path = Path(str(frame["sourcePath"]))
    return path if path.is_absolute() else PIPELINE_ROOT / path


def target_size(plan: dict[str, Any], args: argparse.Namespace) -> tuple[int, int]:
    if args.width and args.height:
        return max(1, args.width), max(1, args.height)
    grid = plan["grid"]
    width = int(math.ceil(float(grid["cellWidth"]) * args.oversample))
    height = int(math.ceil(float(grid["cellHeight"]) * args.oversample))
    return max(1, width), max(1, height)


def clip_cache_key(frame: dict[str, Any], plan: dict[str, Any], args: argparse.Namespace) -> str:
    width, height = target_size(plan, args)
    timing = plan["timing"]
    payload = {
        "schemaVersion": 1,
        "sourceHash": frame["sourceHash"],
        "globalFrame": frame["globalFrame"],
        "frameIndex": frame["frameIndex"],
        "sampleFps": plan["index"]["sampleFps"],
        "preRollSec": timing["preRollSec"],
        "tileFps": timing["tileFps"],
        "width": width,
        "height": height,
        "jpegQuality": args.jpeg_quality,
        "seekMarginSec": args.seek_margin_sec,
    }
    return short_hash(json.dumps(payload, sort_keys=True))


def cached_clip(cache_dir: Path, cache_key: str) -> list[Path] | None:
    meta_path = cache_dir / "meta.json"
    if not meta_path.exists():
        return None
    try:
        meta = read_json(meta_path)
    except (OSError, json.JSONDecodeError):
        return None
    if meta.get("cacheKey") != cache_key:
        return None
    frames = frame_list(cache_dir)
    expected = int(meta.get("frameCount") or 0)
    if not frames or len(frames) != expected:
        return None
    return frames


def build_clip_records(plan: dict[str, Any], args: argparse.Namespace) -> list[dict[str, Any]]:
    width, height = target_size(plan, args)
    sample_fps = float(plan["index"]["sampleFps"])
    pre_roll = float(plan["timing"]["preRollSec"])
    tile_fps = float(plan["timing"]["tileFps"])
    records: list[dict[str, Any]] = []
    for frame in plan["usedFrames"]:
        key_time = float(frame["frameIndex"]) / sample_fps
        start_time = max(0.0, key_time - pre_roll)
        match_at = key_time - start_time
        pre_frame_count = max(0, int(math.ceil(match_at * tile_fps)))
        cache_key = clip_cache_key(frame, plan, args)
        cache_dir = CLIP_CACHE_DIR / cache_key
        records.append(
            {
                **frame,
                "key": frame["candidateKey"],
                "videoPath": str(source_path_for(frame)),
                "cacheKey": cache_key,
                "dir": str(cache_dir),
                "startTimeSec": start_time,
                "keyTimeSec": key_time,
                "matchAtSec": match_at,
                "preFrameCount": pre_frame_count,
                "frameCount": pre_frame_count + 1,
                "matchFrameNumber": pre_frame_count + 1,
                "width": width,
                "height": height,
                "cacheHit": False,
            }
        )
    return records


def seek_exact_vf(frame_index: int, sample_fps: float, width: int, height: int) -> str:
    """Reproduce the Step 1 ``fps`` grid frame exactly, decoding only around its time.

    ``-copyts`` keeps absolute timestamps so the ``fps`` filter lands on the same
    output grid a full decode would, and the ``select`` window isolates the single
    grid frame at ``frame_index / sample_fps``.
    """
    target = frame_index / sample_fps
    window = 0.4 / sample_fps
    return (
        f"fps={sample_fps},"
        f"select=between(t\\,{target - window:.6f}\\,{target + window:.6f}),"
        f"{cover_filter(width, height)}"
    )


def extract_exact_frames(records: list[dict[str, Any]], plan: dict[str, Any], args: argparse.Namespace) -> dict[str, Path]:
    if not records:
        return {}
    sample_fps = float(plan["index"]["sampleFps"])
    exact_root = CLIP_CACHE_DIR / "__exact"
    if exact_root.exists():
        shutil.rmtree(exact_root)
    exact_root.mkdir(parents=True, exist_ok=True)

    print(
        f"[exact] {len(records)} exact frame(s) using copyts seek "
        f"with {args.workers} worker(s)",
        flush=True,
    )

    def extract_one(record: dict[str, Any]) -> tuple[str, Path, float]:
        frame_index = int(record["frameIndex"])
        width, height = int(record["width"]), int(record["height"])
        out = exact_root / f"{record['cacheKey']}.jpg"
        seek = max(0.0, frame_index / sample_fps - args.seek_margin_sec)
        started = time.time()
        run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-copyts",
                "-ss",
                ffmpeg_time(seek),
                "-i",
                record["videoPath"],
                "-vf",
                seek_exact_vf(frame_index, sample_fps, width, height),
                "-vsync",
                "0",
                "-frames:v",
                "1",
                "-q:v",
                str(args.jpeg_quality),
                str(out),
            ]
        )
        if not out.exists():
            raise RuntimeError(f"ffmpeg did not produce exact frame for {record['key']}")
        return str(record["cacheKey"]), out, time.time() - started

    exact_paths: dict[str, Path] = {}
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(extract_one, record): record for record in records}
        for done, future in enumerate(as_completed(futures), start=1):
            cache_key, out, elapsed = future.result()
            exact_paths[cache_key] = out
            print(
                f"[exact {done}/{len(records)}] {Path(out).stem} ({elapsed:.1f}s)",
                flush=True,
            )
    return exact_paths


def extract_preroll_sequence(record: dict[str, Any], args: argparse.Namespace) -> None:
    pre_count = int(record["preFrameCount"])
    if pre_count <= 0:
        return
    duration = pre_count / float(args.tile_fps)
    start_time = float(record["startTimeSec"])
    pre_seek = max(0.0, start_time - args.seek_margin_sec)
    post_seek = start_time - pre_seek
    vf = f"fps={args.tile_fps},{cover_filter(int(record['width']), int(record['height']))}"
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-ss",
        ffmpeg_time(pre_seek),
        "-i",
        record["videoPath"],
        "-ss",
        ffmpeg_time(post_seek),
        "-t",
        ffmpeg_time(duration),
        "-vf",
        vf,
        "-frames:v",
        str(pre_count),
        "-q:v",
        str(args.jpeg_quality),
        str(Path(record["dir"]) / "frame_%04d.jpg"),
    ]
    run(command)


def write_clip_meta(record: dict[str, Any], frames: list[Path], plan_path: Path) -> None:
    meta = {
        "schemaVersion": 1,
        "cacheKey": record["cacheKey"],
        "candidateKey": record["key"],
        "sourceHash": record["sourceHash"],
        "videoPath": record["videoPath"],
        "sourcePath": record["sourcePath"],
        "globalFrame": record["globalFrame"],
        "frameIndex": record["frameIndex"],
        "startTimeSec": record["startTimeSec"],
        "keyTimeSec": record["keyTimeSec"],
        "matchAtSec": record["matchAtSec"],
        "matchFrameNumber": record["matchFrameNumber"],
        "frameCount": len(frames),
        "width": record["width"],
        "height": record["height"],
        "planPath": rel(plan_path),
        "generatedAt": utc_now(),
    }
    write_json(Path(record["dir"]) / "meta.json", meta)


def prepare_one_clip(record: dict[str, Any], exact_path: Path, args: argparse.Namespace, plan_path: Path) -> dict[str, Any]:
    cache_dir = Path(record["dir"])
    if cache_dir.exists():
        shutil.rmtree(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    extract_preroll_sequence(record, args)
    pre_frames = frame_list(cache_dir)
    record["matchFrameNumber"] = len(pre_frames) + 1
    final_frame = cache_dir / f"frame_{int(record['matchFrameNumber']):04d}.jpg"
    shutil.copy2(exact_path, final_frame)
    frames = frame_list(cache_dir)
    if not frames:
        raise RuntimeError(f"No frames produced for {record['key']}")
    record["frameCount"] = len(frames)
    write_clip_meta(record, frames, plan_path)
    out = {key: value for key, value in record.items() if key != "cacheHit"}
    out["dir"] = rel(Path(record["dir"]))
    out["frames"] = [rel(path) for path in frames]
    out["cacheHit"] = False
    return out


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", default=str(DEFAULT_PLAN_PATH), help="Step 2 grid match plan")
    parser.add_argument("--workers", type=int, default=max(1, min(8, os.cpu_count() or 4)))
    parser.add_argument("--width", type=int, default=None, help="override tile frame width")
    parser.add_argument("--height", type=int, default=None, help="override tile frame height")
    parser.add_argument("--oversample", type=float, default=2.0, help="scale over grid cell dimensions")
    parser.add_argument("--jpeg-quality", type=int, default=2, help="ffmpeg q:v JPEG quality")
    parser.add_argument(
        "--exact-chunk-size",
        type=int,
        default=32,
        help="retained for compatibility; no longer used by exact seek extraction",
    )
    parser.add_argument(
        "--seek-margin-sec",
        type=float,
        default=1.0,
        help="seconds decoded before each target: locks the exact fps grid and the preroll window",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    args.workers = max(1, int(args.workers))
    args.jpeg_quality = max(1, int(args.jpeg_quality))
    args.exact_chunk_size = max(1, int(args.exact_chunk_size))
    args.tile_fps = None

    plan_path = Path(args.plan)
    if not plan_path.is_absolute():
        plan_path = PIPELINE_ROOT / plan_path
    if not plan_path.exists():
        raise SystemExit("Missing match plan. Run python3 02-match-cells.py first.")
    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg must be installed and available on PATH")

    plan = read_json(plan_path)
    args.tile_fps = float(plan["timing"]["tileFps"])
    records = build_clip_records(plan, args)
    CLIP_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    clips: list[dict[str, Any] | None] = [None] * len(records)
    missing: list[dict[str, Any]] = []
    cache_hits = 0
    for index, record in enumerate(records):
        cached = cached_clip(Path(record["dir"]), record["cacheKey"])
        if cached:
            cache_hits += 1
            out = {key: value for key, value in record.items() if key != "cacheHit"}
            out["dir"] = rel(Path(record["dir"]))
            out["frames"] = [rel(path) for path in cached]
            out["cacheHit"] = True
            clips[index] = out
        else:
            missing.append(record)

    print(
        f"Preparing {len(records)} clip sequence(s): {cache_hits} cache hit(s), "
        f"{len(missing)} to extract with {args.workers} worker(s)",
        flush=True,
    )
    exact_paths = extract_exact_frames(missing, plan, args)
    if missing:
        index_by_key = {record["cacheKey"]: index for index, record in enumerate(records)}
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = {
                pool.submit(
                    prepare_one_clip,
                    record,
                    exact_paths[record["cacheKey"]],
                    args,
                    plan_path,
                ): record
                for record in missing
            }
            for done, future in enumerate(as_completed(futures), start=1):
                clip = future.result()
                clips[index_by_key[str(clip["cacheKey"])]] = clip
                print(
                    f"[clip {done}/{len(missing)}] {clip['key']} "
                    f"({clip['frameCount']} frame(s), {clip['width']}x{clip['height']})",
                    flush=True,
                )

    manifest = {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "planPath": rel(plan_path),
        "cacheDir": rel(CLIP_CACHE_DIR),
        "cacheHits": cache_hits,
        "clips": clips,
    }
    write_json(CLIPS_MANIFEST_PATH, manifest)
    print(f"Wrote {rel(CLIPS_MANIFEST_PATH)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print(exc, file=sys.stderr)
        if exc.stderr:
            print(exc.stderr, file=sys.stderr)
        raise SystemExit(exc.returncode)
