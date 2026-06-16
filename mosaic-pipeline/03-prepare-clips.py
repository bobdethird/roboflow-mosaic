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

import numpy as np


PIPELINE_ROOT = Path(__file__).resolve().parent
if str(PIPELINE_ROOT) not in sys.path:
    sys.path.insert(0, str(PIPELINE_ROOT))

from camera import window_at_progress, zoom_start_window

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


def valid_jpeg(path: Path) -> bool:
    if not path.exists() or path.stat().st_size <= 2:
        return False
    try:
        with path.open("rb") as handle:
            handle.seek(-2, os.SEEK_END)
            return handle.read(2) == b"\xff\xd9"
    except OSError:
        return False


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


def opening_candidate_key(plan: dict[str, Any]) -> str | None:
    opening_cell = int(plan.get("grid", {}).get("openingCell", 0))
    for assignment in plan.get("assignments", []):
        if int(assignment.get("cellIndex", -1)) == opening_cell:
            return str(assignment.get("candidateKey"))
    return None


def even_dimension(value: int) -> int:
    return value if value % 2 == 0 else value + 1


def normalize_size(width: int, height: int, args: argparse.Namespace) -> tuple[int, int]:
    width, height = max(1, width), max(1, height)
    return (even_dimension(width), even_dimension(height)) if args.cache_format == "video" else (width, height)


def uniform_target_size(plan: dict[str, Any], args: argparse.Namespace) -> tuple[int, int]:
    if args.width and args.height:
        return max(1, args.width), max(1, args.height)
    grid = plan["grid"]
    width = int(math.ceil(float(grid["cellWidth"]) * args.oversample))
    height = int(math.ceil(float(grid["cellHeight"]) * args.oversample))
    return max(1, width), max(1, height)


def target_size(frame: dict[str, Any], plan: dict[str, Any], args: argparse.Namespace) -> tuple[int, int]:
    key = str(frame.get("candidateKey") or frame.get("key") or "")
    if args.opening_width and args.opening_height:
        if key and key == opening_candidate_key(plan):
            return normalize_size(args.opening_width, args.opening_height, args)
    if args.width and args.height:
        return normalize_size(args.width, args.height, args)
    if args.sizing == "adaptive":
        adaptive_sizes = getattr(args, "_adaptive_sizes", {}) or {}
        if key in adaptive_sizes:
            width, height = adaptive_sizes[key]
            return normalize_size(int(width), int(height), args)
    width, height = uniform_target_size(plan, args)
    return normalize_size(width, height, args)


def opening_cell_rect(plan: dict[str, Any]) -> tuple[float, float, float, float]:
    opening_cell = int(plan.get("grid", {}).get("openingCell", 0))
    assignments = plan["assignments"]
    chosen = next((a for a in assignments if int(a["cellIndex"]) == opening_cell), assignments[0])
    return (float(chosen["x"]), float(chosen["y"]), float(chosen["w"]), float(chosen["h"]))


def compute_adaptive_sizes(plan: dict[str, Any], args: argparse.Namespace) -> dict[str, tuple[int, int]]:
    grid = plan["grid"]
    world_w = float(grid["outputWidth"])
    world_h = float(grid["outputHeight"])
    canvas_w = max(1, int(args.target_output_width or round(world_w)))
    canvas_h = max(1, round(canvas_w * world_h / world_w))

    assignments = plan["assignments"]
    cell_x = np.array([float(a["x"]) for a in assignments], dtype=np.float64)
    cell_y = np.array([float(a["y"]) for a in assignments], dtype=np.float64)
    cell_w = np.array([float(a["w"]) for a in assignments], dtype=np.float64)
    cell_h = np.array([float(a["h"]) for a in assignments], dtype=np.float64)
    cell_x1 = cell_x + cell_w
    cell_y1 = cell_y + cell_h
    candidate_keys = [str(a["candidateKey"]) for a in assignments]

    max_w = np.zeros(len(assignments), dtype=np.float64)
    max_h = np.zeros(len(assignments), dtype=np.float64)
    start = zoom_start_window(opening_cell_rect(plan), world_w, world_h)
    for t in np.linspace(0.0, 1.0, max(2, int(args.size_samples))):
        wx, wy, ww, wh = window_at_progress(float(t), start, world_w, world_h)
        visible = (cell_x < wx + ww) & (cell_x1 > wx) & (cell_y < wy + wh) & (cell_y1 > wy)
        if not np.any(visible):
            continue
        screen_w = cell_w[visible] / ww * canvas_w
        screen_h = cell_h[visible] / wh * canvas_h
        max_w[visible] = np.maximum(max_w[visible], screen_w)
        max_h[visible] = np.maximum(max_h[visible], screen_h)

    min_px = max(1, int(args.min_tile_px))
    max_px = max(min_px, int(args.max_tile_px))
    margin = max(0.01, float(args.size_margin))
    by_key: dict[str, tuple[int, int]] = {}
    for key, width, height in zip(candidate_keys, max_w, max_h):
        scaled_w = int(math.ceil(min(max_px, max(min_px, width * margin))))
        scaled_h = int(math.ceil(min(max_px, max(min_px, height * margin))))
        old = by_key.get(key)
        if old is None:
            by_key[key] = (scaled_w, scaled_h)
        else:
            by_key[key] = (max(old[0], scaled_w), max(old[1], scaled_h))
    return by_key


def clip_cache_key(frame: dict[str, Any], plan: dict[str, Any], args: argparse.Namespace) -> str:
    width, height = target_size(frame, plan, args)
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
        "cacheFormat": args.cache_format,
        "sizing": args.sizing,
        "jpegQuality": args.jpeg_quality,
        "seekMarginSec": args.seek_margin_sec,
    }
    if args.sizing == "adaptive":
        payload.update(
            {
                "targetOutputWidth": args.target_output_width,
                "maxTilePx": args.max_tile_px,
                "minTilePx": args.min_tile_px,
                "sizeMargin": args.size_margin,
            }
        )
    if args.cache_format == "video":
        payload.update(
            {
                "proxyCodec": args.proxy_codec,
                "proxyCrf": args.proxy_crf,
                "proxyKeyint": args.proxy_keyint,
                "pixFmt": args.pix_fmt,
            }
        )
    return short_hash(json.dumps(payload, sort_keys=True))


def cached_clip(cache_dir: Path, cache_key: str, args: argparse.Namespace) -> dict[str, Any] | None:
    meta_path = cache_dir / "meta.json"
    if not meta_path.exists():
        return None
    try:
        meta = read_json(meta_path)
    except (OSError, json.JSONDecodeError):
        return None
    if meta.get("cacheKey") != cache_key:
        return None
    cache_format = str(meta.get("cacheFormat") or "jpg")
    if cache_format != args.cache_format:
        return None
    expected = int(meta.get("frameCount") or 0)
    if expected <= 0:
        return None
    if cache_format == "video":
        match_still = cache_dir / "match.jpg"
        pre_count = int(meta.get("preFrameCount") or 0)
        if not match_still.exists() or match_still.stat().st_size <= 0:
            return None
        preroll_video = cache_dir / "preroll.mp4"
        if pre_count > 0 and (not preroll_video.exists() or preroll_video.stat().st_size <= 0):
            return None
        return meta
    frames = frame_list(cache_dir)
    if not frames or len(frames) != expected:
        return None
    meta["frames"] = [rel(path) for path in frames]
    return meta


def build_clip_records(plan: dict[str, Any], args: argparse.Namespace) -> list[dict[str, Any]]:
    opening_key = opening_candidate_key(plan)
    sample_fps = float(plan["index"]["sampleFps"])
    pre_roll = float(plan["timing"]["preRollSec"])
    tile_fps = float(plan["timing"]["tileFps"])
    records: list[dict[str, Any]] = []
    for frame in plan["usedFrames"]:
        width, height = target_size(frame, plan, args)
        is_opening_frame = str(frame.get("candidateKey")) == opening_key
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
                "cacheFormat": args.cache_format,
                "proxyCodec": args.proxy_codec,
                "proxyCrf": args.proxy_crf,
                "proxyKeyint": args.proxy_keyint,
                "pixFmt": args.pix_fmt,
                "isOpeningFrame": is_opening_frame,
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
        if valid_jpeg(out):
            return str(record["cacheKey"]), out, 0.0
        seek = max(0.0, frame_index / sample_fps - args.seek_margin_sec)
        started = time.time()
        command = [
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
        try:
            subprocess.run(
                command,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=True,
                timeout=args.exact_timeout_sec,
            )
        except subprocess.TimeoutExpired as exc:
            if valid_jpeg(out):
                print(
                    f"[warn] exact ffmpeg timed out after {args.exact_timeout_sec:g}s "
                    f"but wrote {out.name}; continuing",
                    flush=True,
                )
            else:
                rendered = " ".join(command[:8] + ["..."])
                raise RuntimeError(
                    f"{rendered} timed out after {args.exact_timeout_sec:g}s "
                    f"without a complete JPEG for {record['key']}"
                ) from exc
        except subprocess.CalledProcessError as exc:
            rendered = " ".join(command[:8] + ["..."])
            detail = (exc.stderr or exc.stdout or "no ffmpeg output").strip()
            raise RuntimeError(f"{rendered} failed ({exc.returncode}): {detail[:1200]}") from exc
        if not valid_jpeg(out):
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
    out_path = Path(record["dir"]) / ("preroll.mp4" if args.cache_format == "video" else "frame_%04d.jpg")
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
    ]
    if args.cache_format == "video":
        command.extend(video_encode_args(args))
    else:
        command.extend(["-q:v", str(args.jpeg_quality)])
    command.append(str(out_path))
    run(command)


def video_encode_args(args: argparse.Namespace) -> list[str]:
    if args.proxy_codec == "libx264":
        return [
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            str(args.proxy_crf),
            "-g",
            str(args.proxy_keyint),
            "-keyint_min",
            str(args.proxy_keyint),
            "-sc_threshold",
            "0",
            "-pix_fmt",
            args.pix_fmt,
            "-movflags",
            "+faststart",
        ]
    if args.proxy_codec == "hevc_videotoolbox":
        return [
            "-an",
            "-c:v",
            "hevc_videotoolbox",
            "-tag:v",
            "hvc1",
            "-b:v",
            "0",
            "-q:v",
            str(args.proxy_crf),
            "-g",
            str(args.proxy_keyint),
            "-pix_fmt",
            args.pix_fmt,
            "-movflags",
            "+faststart",
        ]
    if args.proxy_codec == "prores_ks":
        return [
            "-an",
            "-c:v",
            "prores_ks",
            "-profile:v",
            "0",
            "-pix_fmt",
            "yuv422p10le",
        ]
    raise ValueError(f"Unsupported proxy codec: {args.proxy_codec}")


def clip_output_record(record: dict[str, Any], cache_hit: bool) -> dict[str, Any]:
    out = {key: value for key, value in record.items() if key != "cacheHit"}
    cache_dir = Path(record["dir"])
    out["dir"] = rel(cache_dir)
    out["cacheHit"] = cache_hit
    if record.get("cacheFormat") == "video":
        preroll_video = cache_dir / "preroll.mp4"
        out["prerollVideo"] = rel(preroll_video) if int(record["preFrameCount"]) > 0 else None
        out["matchStill"] = rel(cache_dir / "match.jpg")
        out.pop("frames", None)
    else:
        out["frames"] = [rel(path) for path in frame_list(cache_dir)]
        out.pop("prerollVideo", None)
        out.pop("matchStill", None)
    return out


def write_clip_meta(record: dict[str, Any], plan_path: Path) -> None:
    meta = {
        "schemaVersion": 1,
        "cacheKey": record["cacheKey"],
        "cacheFormat": record["cacheFormat"],
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
        "preFrameCount": record["preFrameCount"],
        "frameCount": record["frameCount"],
        "width": record["width"],
        "height": record["height"],
        "isOpeningFrame": record.get("isOpeningFrame", False),
        "planPath": rel(plan_path),
        "generatedAt": utc_now(),
    }
    if record["cacheFormat"] == "video":
        meta.update(
            {
                "proxyCodec": record["proxyCodec"],
                "proxyCrf": record["proxyCrf"],
                "proxyKeyint": record["proxyKeyint"],
                "pixFmt": record["pixFmt"],
                "prerollVideo": rel(Path(record["dir"]) / "preroll.mp4")
                if int(record["preFrameCount"]) > 0
                else None,
                "matchStill": rel(Path(record["dir"]) / "match.jpg"),
            }
        )
    else:
        meta["frames"] = [rel(path) for path in frame_list(Path(record["dir"]))]
    write_json(Path(record["dir"]) / "meta.json", meta)


def prepare_one_clip(record: dict[str, Any], exact_path: Path, args: argparse.Namespace, plan_path: Path) -> dict[str, Any]:
    cache_dir = Path(record["dir"])
    if cache_dir.exists():
        shutil.rmtree(cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    extract_preroll_sequence(record, args)
    if args.cache_format == "video":
        final_frame = cache_dir / "match.jpg"
        shutil.copy2(exact_path, final_frame)
        if not final_frame.exists():
            raise RuntimeError(f"No match still produced for {record['key']}")
        if int(record["preFrameCount"]) > 0 and not (cache_dir / "preroll.mp4").exists():
            raise RuntimeError(f"No preroll video produced for {record['key']}")
    else:
        pre_frames = frame_list(cache_dir)
        record["matchFrameNumber"] = len(pre_frames) + 1
        final_frame = cache_dir / f"frame_{int(record['matchFrameNumber']):04d}.jpg"
        shutil.copy2(exact_path, final_frame)
        frames = frame_list(cache_dir)
        if not frames:
            raise RuntimeError(f"No frames produced for {record['key']}")
        record["frameCount"] = len(frames)
    write_clip_meta(record, plan_path)
    return clip_output_record(record, cache_hit=False)


def estimated_clip_cost(record: dict[str, Any]) -> int:
    return int(record["width"]) * int(record["height"]) * int(record["frameCount"])


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", default=str(DEFAULT_PLAN_PATH), help="Step 2 grid match plan")
    parser.add_argument("--workers", type=int, default=max(1, min(8, os.cpu_count() or 4)))
    parser.add_argument("--width", type=int, default=None, help="override tile frame width")
    parser.add_argument("--height", type=int, default=None, help="override tile frame height")
    parser.add_argument("--opening-width", type=int, default=None, help="override opening/center clip frame width")
    parser.add_argument("--opening-height", type=int, default=None, help="override opening/center clip frame height")
    parser.add_argument("--oversample", type=float, default=2.0, help="scale over grid cell dimensions")
    parser.add_argument(
        "--sizing",
        choices=("adaptive", "uniform"),
        default=None,
        help="tile sizing mode; default is adaptive for video caches and uniform for jpg caches",
    )
    parser.add_argument(
        "--target-output-width",
        type=int,
        default=None,
        help="output width to size adaptive clips against; defaults to plan native width",
    )
    parser.add_argument("--max-tile-px", type=int, default=1080, help="adaptive tile width/height cap")
    parser.add_argument("--min-tile-px", type=int, default=64, help="adaptive tile width/height floor")
    parser.add_argument("--size-margin", type=float, default=1.05, help="adaptive sizing safety margin")
    parser.add_argument("--size-samples", type=int, default=2048, help="zoom samples for adaptive sizing")
    parser.add_argument("--jpeg-quality", type=int, default=2, help="ffmpeg q:v JPEG quality")
    parser.add_argument("--cache-format", choices=("video", "jpg"), default="video", help="clip cache storage format")
    parser.add_argument(
        "--proxy-codec",
        choices=("libx264", "hevc_videotoolbox", "prores_ks"),
        default="libx264",
        help="video cache codec when --cache-format=video",
    )
    parser.add_argument("--proxy-crf", type=int, default=18, help="proxy quality for libx264 or q:v for videotoolbox")
    parser.add_argument("--proxy-keyint", type=int, default=15, help="proxy keyframe interval for seek/decode speed")
    parser.add_argument("--pix-fmt", default="yuv420p", help="proxy pixel format for video cache")
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
    parser.add_argument(
        "--exact-timeout-sec",
        type=float,
        default=60.0,
        help="timeout per exact-frame ffmpeg extraction; accepts complete JPEGs already written",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    args.workers = max(1, int(args.workers))
    args.jpeg_quality = max(1, int(args.jpeg_quality))
    args.exact_chunk_size = max(1, int(args.exact_chunk_size))
    args.proxy_crf = max(0, int(args.proxy_crf))
    args.proxy_keyint = max(1, int(args.proxy_keyint))
    args.sizing = args.sizing or ("adaptive" if args.cache_format == "video" else "uniform")
    args.max_tile_px = max(1, int(args.max_tile_px))
    args.min_tile_px = max(1, min(int(args.min_tile_px), args.max_tile_px))
    args.size_margin = max(0.01, float(args.size_margin))
    args.size_samples = max(2, int(args.size_samples))
    args.exact_timeout_sec = max(1.0, float(args.exact_timeout_sec))
    if bool(args.opening_width) != bool(args.opening_height):
        raise SystemExit("--opening-width and --opening-height must be passed together")
    if args.opening_width is not None:
        args.opening_width = max(1, int(args.opening_width))
        args.opening_height = max(1, int(args.opening_height))
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
    args.target_output_width = max(
        1,
        int(args.target_output_width or round(float(plan["grid"]["outputWidth"]))),
    )
    args._adaptive_sizes = compute_adaptive_sizes(plan, args) if args.sizing == "adaptive" else {}
    records = build_clip_records(plan, args)
    CLIP_CACHE_DIR.mkdir(parents=True, exist_ok=True)

    clips: list[dict[str, Any] | None] = [None] * len(records)
    missing: list[dict[str, Any]] = []
    cache_hits = 0
    for index, record in enumerate(records):
        cached = cached_clip(Path(record["dir"]), record["cacheKey"], args)
        if cached:
            cache_hits += 1
            clips[index] = clip_output_record(record, cache_hit=True)
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
        missing = sorted(missing, key=estimated_clip_cost, reverse=True)
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
