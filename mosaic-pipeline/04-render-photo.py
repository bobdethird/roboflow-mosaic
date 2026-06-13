#!/usr/bin/env python3
"""Step 4: render a static photo mosaic.

This first renderer is intentionally still-image only. It can render directly
from the Step 2 grid plan by extracting exact matched frames into a photo cache.
If a Step 3 clips manifest is present, it can also reuse those exact final
frames instead.
"""

from __future__ import annotations

import argparse
import hashlib
import json
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
DEFAULT_CLIPS_PATH = DATA_DIR / "clips.json"
DEFAULT_OUT_PATH = PIPELINE_ROOT / "output" / "mosaic.png"
PHOTO_FRAME_CACHE_DIR = DATA_DIR / "photo-frame-cache"

cv2: Any = None
np: Any = None


def load_numeric_dependencies() -> None:
    global cv2, np
    try:
        import cv2 as cv2_module
        import numpy as np_module
    except ModuleNotFoundError as exc:
        raise SystemExit(
            "Missing Python dependency. Run: "
            "python3 -m pip install -r mosaic-pipeline/requirements.txt"
        ) from exc
    cv2 = cv2_module
    np = np_module


def read_json(path: Path) -> Any:
    return json.loads(path.read_text())


def short_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def run(command: list[str]) -> None:
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        rendered = " ".join(command[:8] + ["..."])
        detail = result.stderr.strip() or result.stdout.strip() or "no ffmpeg output"
        raise RuntimeError(f"{rendered} failed ({result.returncode}): {detail[:1200]}")


def rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(PIPELINE_ROOT.resolve()).as_posix()
    except ValueError:
        return str(path)


def resolve_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else PIPELINE_ROOT / path


def reference_size(plan: dict[str, Any]) -> tuple[int, int] | None:
    ref_path = plan.get("referencePath")
    if not ref_path:
        return None
    path = resolve_path(str(ref_path))
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if image is None:
        return None
    h, w = image.shape[:2]
    return int(w), int(h)


def output_size(plan: dict[str, Any], args: argparse.Namespace) -> tuple[int, int]:
    grid = plan["grid"]
    if args.output_width and args.output_height:
        return int(args.output_width), int(args.output_height)
    ref_size = reference_size(plan) if args.output_aspect == "reference" else None
    if args.output_width:
        if ref_size:
            ref_w, ref_h = ref_size
            return int(args.output_width), max(1, round(int(args.output_width) * ref_h / ref_w))
        return int(args.output_width), int(grid["outputHeight"])
    if args.output_height:
        if ref_size:
            ref_w, ref_h = ref_size
            return max(1, round(int(args.output_height) * ref_w / ref_h)), int(args.output_height)
        return int(grid["outputWidth"]), int(args.output_height)
    if ref_size:
        ref_w, ref_h = ref_size
        width = int(grid["outputWidth"])
        return width, max(1, round(width * ref_h / ref_w))
    return int(grid["outputWidth"]), int(grid["outputHeight"])


def cover_resize(image: Any, width: int, height: int) -> Any:
    src_h, src_w = image.shape[:2]
    scale = max(width / src_w, height / src_h)
    scaled_w = max(1, int(round(src_w * scale)))
    scaled_h = max(1, int(round(src_h * scale)))
    resized = cv2.resize(image, (scaled_w, scaled_h), interpolation=cv2.INTER_AREA)
    x0 = max(0, (scaled_w - width) // 2)
    y0 = max(0, (scaled_h - height) // 2)
    return resized[y0 : y0 + height, x0 : x0 + width]


def cover_filter(width: int, height: int) -> str:
    return ",".join(
        [
            f"scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos",
            f"crop={width}:{height}",
            "setsar=1",
        ]
    )


def valid_image(path: Path) -> bool:
    if not path.exists() or not path.stat().st_size:
        return False
    image = cv2.imread(str(path), cv2.IMREAD_COLOR)
    return image is not None and image.size > 0


def clip_by_key(clips_manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for clip in clips_manifest.get("clips", []):
        if not clip:
            continue
        for key_name in ("key", "candidateKey", "cacheKey"):
            value = clip.get(key_name)
            if value:
                out[str(value)] = clip
    return out


def exact_frame_for_clip(clip: dict[str, Any]) -> Path:
    frames = clip.get("frames") or []
    if not frames:
        raise RuntimeError(f"Clip has no frames: {clip.get('key') or clip.get('cacheKey')}")
    match_frame_number = int(clip.get("matchFrameNumber") or len(frames))
    index = max(0, min(len(frames) - 1, match_frame_number - 1))
    return resolve_path(frames[index])


def render_cache_key(plan: dict[str, Any], args: argparse.Namespace, tile_width: int, tile_height: int) -> str:
    payload = {
        "schemaVersion": 1,
        "planGeneratedAt": plan.get("generatedAt"),
        "usedFrames": [
            {
                "globalFrame": frame["globalFrame"],
                "sourceHash": frame["sourceHash"],
                "frameIndex": frame["frameIndex"],
            }
            for frame in plan.get("usedFrames", [])
        ],
        "sampleFps": plan["index"]["sampleFps"],
        "tileWidth": tile_width,
        "tileHeight": tile_height,
        "jpegQuality": args.extract_quality,
        "extractChunkSize": args.extract_chunk_size,
        "method": args.extract_method,
        "seekOffsetSec": args.seek_offset_sec,
    }
    return short_hash(json.dumps(payload, sort_keys=True))


def photo_tile_size(plan: dict[str, Any], args: argparse.Namespace) -> tuple[int, int]:
    output_width, output_height = output_size(plan, args)
    grid = plan["grid"]
    cols = int(grid["cols"])
    rows = int(grid["rows"])
    cell_w = max(1, math_ceil(output_width / cols))
    cell_h = max(1, math_ceil(output_height / rows))
    return (
        max(1, int(round(cell_w * args.tile_oversample))),
        max(1, int(round(cell_h * args.tile_oversample))),
    )


def math_ceil(value: float) -> int:
    return int(np.ceil(value))


def extract_exact_photo_frames(plan: dict[str, Any], args: argparse.Namespace) -> dict[str, Path]:
    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg must be installed and available on PATH")
    tile_width, tile_height = photo_tile_size(plan, args)
    cache_key = render_cache_key(plan, args, tile_width, tile_height)
    cache_dir = PHOTO_FRAME_CACHE_DIR / cache_key
    cache_dir.mkdir(parents=True, exist_ok=True)
    meta_path = cache_dir / "meta.json"

    used_frames = plan.get("usedFrames") or []
    frame_paths = {
        str(frame["candidateKey"]): cache_dir / f"{int(frame['globalFrame'])}.jpg"
        for frame in used_frames
    }
    if meta_path.exists() and all(valid_image(path) for path in frame_paths.values()):
        try:
            meta = read_json(meta_path)
        except (OSError, json.JSONDecodeError):
            meta = {}
        if meta.get("cacheKey") == cache_key:
            print(f"[photo-cache] hit {rel(cache_dir)}", flush=True)
            return frame_paths

    missing = [
        frame
        for frame in used_frames
        if not valid_image(cache_dir / f"{int(frame['globalFrame'])}.jpg")
    ]

    if args.extract_method == "timestamp":
        return extract_timestamp_photo_frames(plan, args, cache_dir, frame_paths, missing, tile_width, tile_height)
    return extract_seek_exact_photo_frames(
        plan, args, cache_dir, frame_paths, missing, tile_width, tile_height, cache_key
    )


def seek_exact_vf(frame_index: int, sample_fps: float, width: int, height: int) -> str:
    """Reproduce the Step 1 ``fps`` grid frame exactly, but only around its time.

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


def extract_seek_exact_photo_frames(
    plan: dict[str, Any],
    args: argparse.Namespace,
    cache_dir: Path,
    frame_paths: dict[str, Path],
    missing: list[dict[str, Any]],
    tile_width: int,
    tile_height: int,
    cache_key: str,
) -> dict[str, Path]:
    sample_fps = float(plan["index"]["sampleFps"])
    print(
        f"[extract] {len(missing)} missing exact frame(s) using copyts seek "
        f"with {args.workers} worker(s)",
        flush=True,
    )

    def extract_one(frame: dict[str, Any]) -> tuple[str, float]:
        source_path = resolve_path(frame["sourcePath"])
        frame_index = int(frame["frameIndex"])
        dst = cache_dir / f"{int(frame['globalFrame'])}.jpg"
        tmp = cache_dir / f"__tmp_{int(frame['globalFrame'])}.jpg"
        tmp.unlink(missing_ok=True)
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
                str(source_path),
                "-vf",
                seek_exact_vf(frame_index, sample_fps, tile_width, tile_height),
                "-vsync",
                "0",
                "-frames:v",
                "1",
                "-q:v",
                str(args.extract_quality),
                str(tmp),
            ]
        )
        if not valid_image(tmp):
            tmp.unlink(missing_ok=True)
            raise RuntimeError(f"ffmpeg wrote an unreadable exact frame for {frame['candidateKey']}")
        tmp.replace(dst)
        return str(frame["candidateKey"]), time.time() - started

    if missing:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = {pool.submit(extract_one, frame): frame for frame in missing}
            for done, future in enumerate(as_completed(futures), start=1):
                key, elapsed = future.result()
                print(f"[extract {done}/{len(missing)}] {key} ({elapsed:.1f}s)", flush=True)

    meta_path = cache_dir / "meta.json"
    meta_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "cacheKey": cache_key,
                "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "planGeneratedAt": plan.get("generatedAt"),
                "sampleFps": sample_fps,
                "tileWidth": tile_width,
                "tileHeight": tile_height,
                "extractChunkSize": args.extract_chunk_size,
                "extractMethod": args.extract_method,
                "seekMarginSec": args.seek_margin_sec,
                "seekOffsetSec": args.seek_offset_sec,
                "frameCount": len(plan.get("usedFrames") or []),
            },
            indent=2,
        )
        + "\n"
    )
    return frame_paths


def ffmpeg_time(seconds: float) -> str:
    return f"{max(0.0, seconds):.6f}"


def extract_timestamp_photo_frames(
    plan: dict[str, Any],
    args: argparse.Namespace,
    cache_dir: Path,
    frame_paths: dict[str, Path],
    missing: list[dict[str, Any]],
    tile_width: int,
    tile_height: int,
) -> dict[str, Path]:
    print(
        f"[extract] {len(missing)} missing frame(s) using timestamp seek "
        f"with {args.workers} worker(s)",
        flush=True,
    )
    sample_fps = float(plan["index"]["sampleFps"])

    def extract_one(frame: dict[str, Any]) -> tuple[str, float]:
        source_path = resolve_path(frame["sourcePath"])
        dst = cache_dir / f"{int(frame['globalFrame'])}.jpg"
        tmp = cache_dir / f"__tmp_{int(frame['globalFrame'])}.jpg"
        tmp.unlink(missing_ok=True)
        timestamp = float(frame.get("frameTimeSec", float(frame["frameIndex"]) / sample_fps))
        timestamp = max(0.0, timestamp + args.seek_offset_sec)
        started = time.time()
        run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-ss",
                ffmpeg_time(timestamp),
                "-i",
                str(source_path),
                "-frames:v",
                "1",
                "-vf",
                cover_filter(tile_width, tile_height),
                "-q:v",
                str(args.extract_quality),
                str(tmp),
            ]
        )
        if not valid_image(tmp):
            tmp.unlink(missing_ok=True)
            raise RuntimeError(f"ffmpeg wrote an unreadable timestamp frame for {frame['candidateKey']}")
        tmp.replace(dst)
        return str(frame["candidateKey"]), time.time() - started

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(extract_one, frame): frame for frame in missing}
        for done, future in enumerate(as_completed(futures), start=1):
            key, elapsed = future.result()
            print(f"[extract {done}/{len(missing)}] {key} ({elapsed:.1f}s)", flush=True)

    meta_path = cache_dir / "meta.json"
    meta_path.write_text(
        json.dumps(
            {
                "schemaVersion": 1,
                "cacheKey": render_cache_key(plan, args, tile_width, tile_height),
                "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "planGeneratedAt": plan.get("generatedAt"),
                "sampleFps": sample_fps,
                "tileWidth": tile_width,
                "tileHeight": tile_height,
                "extractMethod": args.extract_method,
                "seekOffsetSec": args.seek_offset_sec,
                "frameCount": len(plan.get("usedFrames") or []),
            },
            indent=2,
        )
        + "\n"
    )
    return frame_paths


def frame_paths_from_clips(clips_manifest: dict[str, Any]) -> dict[str, Path]:
    return {
        key: exact_frame_for_clip(clip)
        for key, clip in clip_by_key(clips_manifest).items()
    }


def resolve_frame_paths(plan: dict[str, Any], args: argparse.Namespace) -> dict[str, Path]:
    clips_path = resolve_path(args.clips)
    if args.use_clips and clips_path.exists():
        print(f"[clips] using {rel(clips_path)}", flush=True)
        return frame_paths_from_clips(read_json(clips_path))
    if args.use_clips and not clips_path.exists():
        raise SystemExit("Missing clips manifest. Run python3 03-prepare-clips.py or omit --use-clips.")
    return extract_exact_photo_frames(plan, args)


def render_photo(plan: dict[str, Any], frame_paths: dict[str, Path], args: argparse.Namespace) -> tuple[Path, Path]:
    grid = plan["grid"]
    output_width, output_height = output_size(plan, args)
    cols = int(grid["cols"])
    rows = int(grid["rows"])
    canvas = np.zeros((output_height, output_width, 3), np.uint8)
    image_cache: dict[tuple[str, int, int], Any] = {}

    for index, assignment in enumerate(plan["assignments"], start=1):
        row = int(assignment["row"])
        col = int(assignment["col"])
        x0 = round(col * output_width / cols)
        x1 = round((col + 1) * output_width / cols)
        y0 = round(row * output_height / rows)
        y1 = round((row + 1) * output_height / rows)
        cell_w = max(1, x1 - x0)
        cell_h = max(1, y1 - y0)
        key = str(assignment["candidateKey"])
        frame_path = frame_paths.get(key)
        if frame_path is None:
            raise RuntimeError(f"Missing exact frame for assignment {key}")
        cache_key = (str(frame_path), cell_w, cell_h)
        tile = image_cache.get(cache_key)
        if tile is None:
            image = cv2.imread(str(frame_path), cv2.IMREAD_COLOR)
            if image is None:
                try:
                    frame_path.unlink(missing_ok=True)
                except OSError:
                    pass
                raise RuntimeError(f"Could not read clip frame: {frame_path}")
            tile = cover_resize(image, cell_w, cell_h)
            image_cache[cache_key] = tile
        canvas[y0:y1, x0:x1] = tile
        if index == 1 or index == len(plan["assignments"]) or index % max(1, len(plan["assignments"]) // 20) == 0:
            print(f"[render] {index}/{len(plan['assignments'])}", flush=True)

    out_path = resolve_path(args.out)
    poster_path = resolve_path(args.poster) if args.poster else out_path.with_name(f"{out_path.stem}_poster.jpg")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    poster_path.parent.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(out_path), canvas)
    if args.poster_width > 0:
        poster_w = min(int(args.poster_width), output_width)
        poster_h = max(1, int(round(poster_w * output_height / output_width)))
        poster = cv2.resize(canvas, (poster_w, poster_h), interpolation=cv2.INTER_AREA)
        cv2.imwrite(str(poster_path), poster, [cv2.IMWRITE_JPEG_QUALITY, int(args.poster_quality)])
    return out_path, poster_path


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", default=str(DEFAULT_PLAN_PATH), help="Step 2 grid match plan")
    parser.add_argument("--clips", default=str(DEFAULT_CLIPS_PATH), help="optional Step 3 clips manifest")
    parser.add_argument("--use-clips", action="store_true", help="reuse Step 3 clip frames instead of direct extraction")
    parser.add_argument("--out", default=str(DEFAULT_OUT_PATH), help="output PNG path")
    parser.add_argument("--poster", default=None, help="poster JPG path")
    parser.add_argument("--poster-width", type=int, default=1920, help="0 disables poster output")
    parser.add_argument("--poster-quality", type=int, default=92)
    parser.add_argument("--extract-quality", type=int, default=2, help="ffmpeg q:v for direct exact-frame cache")
    parser.add_argument(
        "--extract-method",
        choices=["exact", "timestamp"],
        default="exact",
        help="exact is frame-number accurate via copyts seek (fast); timestamp is approximate",
    )
    parser.add_argument(
        "--extract-chunk-size",
        type=int,
        default=32,
        help="retained for cache-key compatibility; no longer used by exact seek extraction",
    )
    parser.add_argument(
        "--seek-margin-sec",
        type=float,
        default=0.5,
        help="exact seek decodes this many seconds before the target frame to lock the fps grid",
    )
    parser.add_argument(
        "--seek-offset-sec",
        type=float,
        default=0.0,
        help="offset added to timestamp-seek extraction time; only for --extract-method timestamp",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=max(1, min(8, os_cpu_count())),
        help="parallel per-frame ffmpeg seek workers",
    )
    parser.add_argument("--tile-oversample", type=float, default=2.0, help="direct extraction size multiplier")
    parser.add_argument(
        "--output-aspect",
        choices=["plan", "reference"],
        default="plan",
        help="use plan canvas aspect or reference image aspect when output size is not fully specified",
    )
    parser.add_argument("--output-width", type=int, default=None, help="override plan output width")
    parser.add_argument("--output-height", type=int, default=None, help="override plan output height")
    args = parser.parse_args(argv)
    args.workers = max(1, int(args.workers))
    args.extract_chunk_size = max(1, int(args.extract_chunk_size))
    args.seek_margin_sec = max(0.0, float(args.seek_margin_sec))
    return args


def os_cpu_count() -> int:
    import os

    return os.cpu_count() or 4


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    load_numeric_dependencies()
    plan_path = resolve_path(args.plan)
    if not plan_path.exists():
        raise SystemExit("Missing match plan. Run python3 02-match-cells.py first.")
    plan = read_json(plan_path)
    frame_paths = resolve_frame_paths(plan, args)
    out_path, poster_path = render_photo(plan, frame_paths, args)
    print(f"Wrote {rel(out_path)}")
    if args.poster_width > 0:
        print(f"Wrote {rel(poster_path)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
