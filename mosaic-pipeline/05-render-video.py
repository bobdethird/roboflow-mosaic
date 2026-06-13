#!/usr/bin/env python3
"""Step 5: render the zoom-out mosaic video.

This consumes the Step 2 grid plan (`data/matches/grid-plan.json`) and the Step 3
clip sequences (`data/clips.json`) and renders an mp4 that starts zoomed into the
opening cell and zooms out to reveal the full mosaic while each tile clip plays
toward its matched frame.

The camera math is a direct port of the reference pipeline
(`../pipeline/lib/grid.mjs` + `../pipeline/04-render.mjs`):

- ``zoom_start_window`` frames the opening cell, expanded to the output aspect.
- ``zoom_window`` grows the window with a constant zoom factor (geometric in
  size) and pans the top-left toward (0, 0) in proportion to the size progress.
- ``screen_rect`` maps a world-space cell rect through the window into canvas px.
- ``frame_for_clip`` picks which cached clip frame to show at a given time, with
  an optional per-cell play-start stagger and tile-start delay.

After the zoom completes the final mosaic is held for ``freezeSec`` (those frames
are identical, so they are rendered once and copied). Frames are cached in a
content-hashed directory so interrupted renders resume.
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
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path
from types import SimpleNamespace
from typing import Any


PIPELINE_ROOT = Path(__file__).resolve().parent
DATA_DIR = PIPELINE_ROOT / "data"
DEFAULT_PLAN_PATH = DATA_DIR / "matches" / "grid-plan.json"
DEFAULT_CLIPS_PATH = DATA_DIR / "clips.json"
DEFAULT_OUT_PATH = PIPELINE_ROOT / "output" / "mosaic.mp4"
RENDER_FRAMES_DIR = DATA_DIR / "render-frames"

cv2: Any = None
np: Any = None

# Per-process render context populated by ``_init_worker`` (and by ``main`` for
# the serial path). Holds the canvas, cell-rect arrays, and clip lookup.
_CTX: SimpleNamespace | None = None


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


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2) + "\n")


def short_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:16]


def rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(PIPELINE_ROOT.resolve()).as_posix()
    except ValueError:
        return str(path)


def resolve_path(value: str | Path) -> Path:
    path = Path(value)
    return path if path.is_absolute() else PIPELINE_ROOT / path


def run(command: list[str]) -> None:
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode != 0:
        rendered = " ".join(command[:8] + ["..."])
        detail = result.stderr.strip() or result.stdout.strip() or "no ffmpeg output"
        raise RuntimeError(f"{rendered} failed ({result.returncode}): {detail[:1200]}")


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def iround(value: float) -> int:
    """Round half-up, matching JS ``Math.round`` for the screen-rect mapping."""
    return int(math.floor(value + 0.5))


def hash_int(n: int) -> int:
    """32-bit integer hash; mirrors ``hashInt`` in pipeline/04-render.mjs."""
    x = n & 0xFFFFFFFF
    x = (x ^ 61 ^ (x >> 16)) & 0xFFFFFFFF
    x = (x + ((x << 3) & 0xFFFFFFFF)) & 0xFFFFFFFF
    x = (x ^ (x >> 4)) & 0xFFFFFFFF
    x = (x * 0x27D4EB2D) & 0xFFFFFFFF
    x = (x ^ (x >> 15)) & 0xFFFFFFFF
    return x


def parse_color(value: str) -> tuple[int, int, int]:
    """Parse ``#rrggbb`` (or ``rrggbb``) into an OpenCV BGR tuple."""
    text = value.strip().lstrip("#")
    if len(text) == 3:
        text = "".join(channel * 2 for channel in text)
    if len(text) != 6:
        raise argparse.ArgumentTypeError(f"invalid color: {value!r} (use #rrggbb)")
    r = int(text[0:2], 16)
    g = int(text[2:4], 16)
    b = int(text[4:6], 16)
    return (b, g, r)


# --------------------------------------------------------------------------- #
# Camera math (ported from pipeline/lib/grid.mjs)
# --------------------------------------------------------------------------- #


def opening_cell_rect(plan: dict[str, Any], opening_cell: int) -> tuple[float, float, float, float]:
    """World-space rect of the opening cell (falls back to the first assignment)."""
    assignments = plan["assignments"]
    chosen = next((a for a in assignments if int(a["cellIndex"]) == opening_cell), assignments[0])
    return (float(chosen["x"]), float(chosen["y"]), float(chosen["w"]), float(chosen["h"]))


def zoom_start_window(rect: tuple[float, float, float, float], world_w: float, world_h: float) -> tuple[float, float, float, float]:
    """Opening-cell rect expanded to the output aspect, clamped to the world."""
    rect_x, rect_y, rect_w, rect_h = rect
    aspect = world_w / world_h
    w = min(world_w, max(rect_w, rect_h * aspect))
    h = w / aspect
    x = clamp(rect_x + rect_w / 2 - w / 2, 0.0, world_w - w)
    y = clamp(rect_y + rect_h / 2 - h / 2, 0.0, world_h - h)
    return (x, y, w, h)


def zoom_window(time_sec: float, ctx: SimpleNamespace) -> tuple[float, float, float, float]:
    """Window (world coords) at ``time_sec``; constant-factor zoom-out."""
    world_w, world_h = ctx.world_w, ctx.world_h
    effective_zoom = ctx.effective_zoom
    zoom_hold = ctx.zoom_hold
    if time_sec >= effective_zoom:
        return (0.0, 0.0, world_w, world_h)
    start_x, start_y, start_w, start_h = ctx.start
    if time_sec <= zoom_hold:
        return ctx.start
    raw_t = (time_sec - zoom_hold) / max(0.001, effective_zoom - zoom_hold)
    t = clamp(raw_t, 0.0, 1.0)
    w = start_w * math.pow(world_w / start_w, t)
    h = start_h * math.pow(world_h / start_h, t)
    size_t = clamp((w - start_w) / max(0.001, world_w - start_w), 0.0, 1.0)
    x = start_x + (0.0 - start_x) * size_t
    y = start_y + (0.0 - start_y) * size_t
    return (x, y, w, h)


def frame_for_clip(frames_len: int, match_at: float | None, time_sec: float, cell_index: int, ctx: SimpleNamespace) -> int:
    """Index into a clip's frames at ``time_sec`` (ported from frameForClip)."""
    last = max(0, frames_len - 1)
    is_opening = cell_index == ctx.opening_cell
    delay = (
        min(max(0.0, ctx.tile_start_delay), max(0.0, ctx.pre_roll - 0.001))
        if (not is_opening and ctx.tile_start_delay)
        else 0.0
    )
    stagger = ctx.play_stagger
    if delay > 0 and time_sec < delay:
        return 0
    if delay > 0 and time_sec < ctx.pre_roll:
        start_frame = iround(stagger * ((hash_int(cell_index) % 1000) / 1000) * last) if stagger > 0 else 0
        max_playable = max(0, last - start_frame)
        progress = clamp((time_sec - delay) / max(0.001, ctx.pre_roll - delay), 0.0, 1.0)
        return int(clamp(start_frame + iround(progress * max_playable), 0, last))
    match_at_sec = match_at if match_at is not None else ctx.pre_roll
    if time_sec >= match_at_sec:
        return last
    start_frame = iround(stagger * ((hash_int(cell_index) % 1000) / 1000) * last) if stagger > 0 else 0
    max_playable = max(0, last - start_frame)
    progress = clamp(time_sec / max(0.001, match_at_sec), 0.0, 1.0)
    return int(clamp(start_frame + iround(progress * max_playable), 0, last))


# --------------------------------------------------------------------------- #
# Drawing
# --------------------------------------------------------------------------- #


def cover_resize(image: Any, width: int, height: int) -> Any:
    """Scale to cover (width, height) then center-crop; upscales with linear."""
    src_h, src_w = image.shape[:2]
    scale = max(width / src_w, height / src_h)
    scaled_w = max(width, int(round(src_w * scale)))
    scaled_h = max(height, int(round(src_h * scale)))
    interp = cv2.INTER_AREA if (scaled_w < src_w or scaled_h < src_h) else cv2.INTER_LINEAR
    resized = cv2.resize(image, (scaled_w, scaled_h), interpolation=interp)
    x0 = max(0, (scaled_w - width) // 2)
    y0 = max(0, (scaled_h - height) // 2)
    return resized[y0 : y0 + height, x0 : x0 + width]


def blit_cover(canvas: Any, image: Any, x: float, y: float, w: float, h: float) -> None:
    """Cover-fit ``image`` into screen rect (x, y, w, h), clipped to the canvas.

    Adjacent cells share rounded edges (round of a shared world edge is equal),
    so tiles tile seamlessly without overlap or gaps.
    """
    canvas_h, canvas_w = canvas.shape[:2]
    x0 = iround(x)
    y0 = iround(y)
    x1 = iround(x + w)
    y1 = iround(y + h)
    dst_w = x1 - x0
    dst_h = y1 - y0
    if dst_w <= 0 or dst_h <= 0:
        return
    cx0 = max(0, x0)
    cy0 = max(0, y0)
    cx1 = min(canvas_w, x1)
    cy1 = min(canvas_h, y1)
    if cx1 <= cx0 or cy1 <= cy0:
        return
    tile = cover_resize(image, dst_w, dst_h)
    tx0 = cx0 - x0
    ty0 = cy0 - y0
    canvas[cy0:cy1, cx0:cx1] = tile[ty0 : ty0 + (cy1 - cy0), tx0 : tx0 + (cx1 - cx0)]


# --------------------------------------------------------------------------- #
# Render context
# --------------------------------------------------------------------------- #


def output_canvas_size(world_w: float, world_h: float, args: argparse.Namespace) -> tuple[int, int]:
    if args.output_width:
        cw = int(args.output_width)
        ch = max(1, round(cw * world_h / world_w))
    elif args.scale and args.scale != 1.0:
        cw = max(1, round(world_w * args.scale))
        ch = max(1, round(world_h * args.scale))
    else:
        cw = int(round(world_w))
        ch = int(round(world_h))
    # libx264 + yuv420p require even dimensions.
    cw -= cw % 2
    ch -= ch % 2
    return max(2, cw), max(2, ch)


def build_clips_by_key(clips_manifest: dict[str, Any]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for clip in clips_manifest.get("clips", []):
        if not clip:
            continue
        frames = clip.get("frames") or []
        if not frames:
            continue
        record = {
            "frames": [str(resolve_path(frame)) for frame in frames],
            "match_at": (float(clip["matchAtSec"]) if clip.get("matchAtSec") is not None else None),
            "n": len(frames),
        }
        for key_name in ("candidateKey", "key", "cacheKey"):
            value = clip.get(key_name)
            if value and str(value) not in out:
                out[str(value)] = record
    return out


def build_context(plan: dict[str, Any], clips_manifest: dict[str, Any], params: dict[str, Any]) -> SimpleNamespace:
    grid = plan["grid"]
    world_w = float(grid["outputWidth"])
    world_h = float(grid["outputHeight"])
    assignments = plan["assignments"]
    n = len(assignments)

    cell_x = np.empty(n, np.float64)
    cell_y = np.empty(n, np.float64)
    cell_w = np.empty(n, np.float64)
    cell_h = np.empty(n, np.float64)
    cell_index = np.empty(n, np.int64)
    candidate_keys: list[str] = [""] * n
    idx_by_cell: dict[int, int] = {}
    for i, assignment in enumerate(assignments):
        cell_x[i] = float(assignment["x"])
        cell_y[i] = float(assignment["y"])
        cell_w[i] = float(assignment["w"])
        cell_h[i] = float(assignment["h"])
        ci = int(assignment["cellIndex"])
        cell_index[i] = ci
        candidate_keys[i] = str(assignment["candidateKey"])
        idx_by_cell[ci] = i

    clips_by_key = build_clips_by_key(clips_manifest)

    opening_cell = int(grid.get("openingCell", 0))
    opening_i = idx_by_cell.get(opening_cell, 0)
    opening_rect = (
        float(cell_x[opening_i]),
        float(cell_y[opening_i]),
        float(cell_w[opening_i]),
        float(cell_h[opening_i]),
    )

    canvas_w = int(params["canvas_w"])
    canvas_h = int(params["canvas_h"])
    background = params["background"]

    ctx = SimpleNamespace(
        world_w=world_w,
        world_h=world_h,
        canvas_w=canvas_w,
        canvas_h=canvas_h,
        cell_x=cell_x,
        cell_y=cell_y,
        cell_w=cell_w,
        cell_h=cell_h,
        cell_x1=cell_x + cell_w,
        cell_y1=cell_y + cell_h,
        cell_index=cell_index,
        candidate_keys=candidate_keys,
        clips_by_key=clips_by_key,
        opening_cell=opening_cell,
        start=zoom_start_window(opening_rect, world_w, world_h),
        fps=float(params["fps"]),
        pre_roll=float(params["pre_roll"]),
        effective_zoom=float(params["effective_zoom"]),
        zoom_hold=float(params["zoom_hold"]),
        tile_start_delay=float(params["tile_start_delay"]),
        play_stagger=float(params["play_stagger"]),
        jpeg_quality=int(params["jpeg_quality"]),
        frame_dir=Path(params["frame_dir"]),
        background=np.array(background, np.uint8),
        canvas=np.empty((canvas_h, canvas_w, 3), np.uint8),
        image_cache={},
    )
    return ctx


def visible_indices(window: tuple[float, float, float, float], ctx: SimpleNamespace) -> Any:
    wx, wy, ww, wh = window
    mask = (
        (ctx.cell_x < wx + ww)
        & (ctx.cell_x1 > wx)
        & (ctx.cell_y < wy + wh)
        & (ctx.cell_y1 > wy)
    )
    return np.nonzero(mask)[0]


def frame_file_for(frame_dir: Path, frame_index: int) -> Path:
    return frame_dir / f"frame_{frame_index + 1:05d}.jpg"


def frame_file(ctx: SimpleNamespace, frame_index: int) -> Path:
    return frame_file_for(ctx.frame_dir, frame_index)


def render_frame(ctx: SimpleNamespace, frame_index: int) -> Path:
    time_sec = frame_index / ctx.fps
    window = zoom_window(time_sec, ctx)
    canvas = ctx.canvas
    canvas[:] = ctx.background

    cw = ctx.canvas_w
    ch = ctx.canvas_h
    wx, wy, ww, wh = window
    cell_x = ctx.cell_x
    cell_y = ctx.cell_y
    cell_w = ctx.cell_w
    cell_h = ctx.cell_h
    cache = ctx.image_cache

    needed: set[str] = set()
    draws: list[tuple[int, str]] = []
    for i in visible_indices(window, ctx):
        i = int(i)
        clip = ctx.clips_by_key.get(ctx.candidate_keys[i])
        if clip is None:
            continue
        f_idx = frame_for_clip(clip["n"], clip["match_at"], time_sec, int(ctx.cell_index[i]), ctx)
        path = clip["frames"][f_idx]
        needed.add(path)
        draws.append((i, path))

    for path in needed:
        if path not in cache:
            image = cv2.imread(path, cv2.IMREAD_COLOR)
            if image is None:
                raise RuntimeError(f"Could not read clip frame: {path}")
            cache[path] = image

    for i, path in draws:
        image = cache.get(path)
        if image is None:
            continue
        sx = (cell_x[i] - wx) / ww * cw
        sy = (cell_y[i] - wy) / wh * ch
        sw = cell_w[i] / ww * cw
        sh = cell_h[i] / wh * ch
        blit_cover(canvas, image, sx, sy, sw, sh)

    for path in list(cache.keys()):
        if path not in needed:
            del cache[path]

    out_path = frame_file(ctx, frame_index)
    ok = cv2.imwrite(str(out_path), canvas, [cv2.IMWRITE_JPEG_QUALITY, ctx.jpeg_quality])
    if not ok:
        raise RuntimeError(f"Failed to write frame {out_path}")
    return out_path


# --------------------------------------------------------------------------- #
# Parallel workers
# --------------------------------------------------------------------------- #


def _init_worker(plan_path: str, clips_path: str, params: dict[str, Any]) -> None:
    global cv2, np, _CTX
    import cv2 as cv2_module
    import numpy as np_module

    cv2 = cv2_module
    np = np_module
    plan = read_json(Path(plan_path))
    clips_manifest = read_json(Path(clips_path))
    _CTX = build_context(plan, clips_manifest, params)


def _render_chunk(indices: list[int]) -> tuple[int, int, float]:
    assert _CTX is not None
    started = time.time()
    total = len(indices)
    for done, frame_index in enumerate(indices, start=1):
        render_frame(_CTX, frame_index)
        if done == 1 or done == total or frame_index % int(_CTX.fps) == 0:
            print(
                f"[render] frame {frame_index + 1} (t={frame_index / _CTX.fps:.2f}s) "
                f"[{done}/{total} in chunk]",
                flush=True,
            )
    return indices[0], indices[-1], time.time() - started


def chunk_indices(indices: list[int], workers: int) -> list[list[int]]:
    """Split sorted indices into ``workers`` contiguous slices for cache locality."""
    if workers <= 1 or len(indices) <= 1:
        return [indices] if indices else []
    size = math.ceil(len(indices) / workers)
    return [indices[i : i + size] for i in range(0, len(indices), size)]


# --------------------------------------------------------------------------- #
# Orchestration
# --------------------------------------------------------------------------- #


def render_cache_key(plan: dict[str, Any], clips_manifest: dict[str, Any], params: dict[str, Any]) -> str:
    payload = {
        "schemaVersion": 1,
        "planGeneratedAt": plan.get("generatedAt"),
        "clipsGeneratedAt": clips_manifest.get("generatedAt"),
        "assignments": [
            {"cellIndex": a["cellIndex"], "candidateKey": a["candidateKey"]}
            for a in plan["assignments"]
        ],
        "grid": plan["grid"],
        "timing": plan["timing"],
        "canvas": [params["canvas_w"], params["canvas_h"]],
        "fps": params["fps"],
        "preRoll": params["pre_roll"],
        "effectiveZoom": params["effective_zoom"],
        "zoomHold": params["zoom_hold"],
        "freeze": params["freeze"],
        "tileStartDelay": params["tile_start_delay"],
        "playStagger": params["play_stagger"],
        "jpegQuality": params["jpeg_quality"],
        "background": list(params["background"]),
        "crf": params["crf"],
        "preset": params["preset"],
    }
    return short_hash(json.dumps(payload, sort_keys=True))


def encode_video(frame_dir: Path, fps: float, out_path: Path, crf: int, preset: str) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = out_path.with_suffix(".tmp.mp4")
    run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-framerate",
            f"{fps:g}",
            "-i",
            str(frame_dir / "frame_%05d.jpg"),
            "-vf",
            "format=yuv420p",
            "-c:v",
            "libx264",
            "-preset",
            preset,
            "-crf",
            str(crf),
            "-movflags",
            "+faststart",
            str(tmp_path),
        ]
    )
    tmp_path.replace(out_path)


def write_poster(last_frame: Path, poster_path: Path, poster_width: int, poster_quality: int) -> None:
    poster_path.parent.mkdir(parents=True, exist_ok=True)
    image = cv2.imread(str(last_frame), cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not read final frame for poster: {last_frame}")
    if poster_width > 0 and poster_width < image.shape[1]:
        h, w = image.shape[:2]
        poster_h = max(1, round(poster_width * h / w))
        image = cv2.resize(image, (poster_width, poster_h), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(poster_path), image, [cv2.IMWRITE_JPEG_QUALITY, poster_quality])


def valid_frame(path: Path) -> bool:
    return path.exists() and path.stat().st_size > 0


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--plan", default=str(DEFAULT_PLAN_PATH), help="Step 2 grid match plan")
    parser.add_argument("--clips", default=str(DEFAULT_CLIPS_PATH), help="Step 3 clips manifest")
    parser.add_argument("--out", default=str(DEFAULT_OUT_PATH), help="output mp4 path")
    parser.add_argument("--poster", default=None, help="poster JPG path (default <out>_poster.jpg)")
    parser.add_argument("--poster-width", type=int, default=1920, help="0 keeps full width")
    parser.add_argument("--poster-quality", type=int, default=92)
    parser.add_argument("--fps", type=float, default=None, help="override plan timing fps")
    parser.add_argument(
        "--zoom-duration-sec",
        type=float,
        default=0.0,
        help="seconds for the zoom-out; 0 spans the full pre-roll, >0 is clamped to pre-roll",
    )
    parser.add_argument(
        "--zoom-hold-sec",
        type=float,
        default=0.0,
        help="hold on the opening cell before zooming (counted inside the zoom duration)",
    )
    parser.add_argument(
        "--freeze-sec",
        type=float,
        default=None,
        help="hold the final mosaic after the zoom (default: plan timing freezeSec)",
    )
    parser.add_argument(
        "--tile-start-delay-sec",
        type=float,
        default=0.0,
        help="delay non-opening tile playback; the opening tile still plays from t=0",
    )
    parser.add_argument(
        "--play-start-stagger",
        type=float,
        default=0.5,
        help="per-cell randomized clip start offset, as a fraction of clip length",
    )
    parser.add_argument("--background", type=parse_color, default=parse_color("#050505"), help="background color #rrggbb")
    parser.add_argument("--scale", type=float, default=1.0, help="canvas scale vs plan output size")
    parser.add_argument("--output-width", type=int, default=None, help="explicit canvas width (height from aspect)")
    parser.add_argument("--crf", type=int, default=18, help="libx264 quality (lower = better)")
    parser.add_argument("--preset", default="veryfast", help="libx264 encode preset")
    parser.add_argument("--jpeg-quality", type=int, default=95, help="intermediate frame JPEG quality")
    parser.add_argument("--frames-dir", default=str(RENDER_FRAMES_DIR), help="render frame cache root")
    parser.add_argument("--workers", type=int, default=max(1, min(8, os.cpu_count() or 4)), help="parallel render workers")
    parser.add_argument("--max-seconds", type=float, default=None, help="cap render duration (useful for tests)")
    parser.add_argument("--preview-poster", action="store_true", help="render only the final still to the poster, skip video")
    parser.add_argument("--force", action="store_true", help="ignore the render cache and re-render")
    return parser.parse_args(argv)


def resolve_params(plan: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    timing = plan["timing"]
    grid = plan["grid"]
    fps = float(args.fps) if args.fps else float(timing["fps"])
    pre_roll = float(timing["preRollSec"])
    zoom_duration = max(0.0, float(args.zoom_duration_sec))
    effective_zoom = min(zoom_duration, pre_roll) if zoom_duration > 0 else pre_roll
    zoom_hold = clamp(float(args.zoom_hold_sec), 0.0, max(0.0, effective_zoom - 0.001))
    freeze = float(args.freeze_sec) if args.freeze_sec is not None else float(timing.get("freezeSec", 0.0))
    freeze = max(0.0, freeze)
    canvas_w, canvas_h = output_canvas_size(float(grid["outputWidth"]), float(grid["outputHeight"]), args)
    return {
        "fps": fps,
        "pre_roll": pre_roll,
        "effective_zoom": effective_zoom,
        "zoom_hold": zoom_hold,
        "freeze": freeze,
        "tile_start_delay": max(0.0, float(args.tile_start_delay_sec)),
        "play_stagger": max(0.0, float(args.play_start_stagger)),
        "canvas_w": canvas_w,
        "canvas_h": canvas_h,
        "background": tuple(int(c) for c in args.background),
        "jpeg_quality": max(1, min(100, int(args.jpeg_quality))),
        "crf": int(args.crf),
        "preset": str(args.preset),
    }


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    args.workers = max(1, int(args.workers))
    load_numeric_dependencies()

    plan_path = resolve_path(args.plan)
    if not plan_path.exists():
        raise SystemExit("Missing match plan. Run python3 02-match-cells.py first.")
    clips_path = resolve_path(args.clips)
    if not clips_path.exists():
        raise SystemExit("Missing clips manifest. Run python3 03-prepare-clips.py first.")
    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg must be installed and available on PATH")

    plan = read_json(plan_path)
    clips_manifest = read_json(clips_path)
    if not plan.get("assignments"):
        raise SystemExit("Match plan has no assignments.")
    if not clips_manifest.get("clips"):
        raise SystemExit("Clips manifest has no clips.")

    params = resolve_params(plan, args)
    params["frame_dir"] = ""  # filled per-context below

    out_path = resolve_path(args.out)
    poster_path = (
        resolve_path(args.poster)
        if args.poster
        else out_path.with_name(f"{out_path.stem}_poster.jpg")
    )

    fps = params["fps"]
    effective_zoom = params["effective_zoom"]
    pre_roll = params["pre_roll"]
    freeze = params["freeze"]
    render_duration = effective_zoom + freeze
    if args.max_seconds is not None:
        render_duration = min(render_duration, max(0.0, float(args.max_seconds)))
    total_frames = max(1, round(render_duration * fps))
    # The composition is static once the window is full (>= effective_zoom) and
    # every clip is on its matched frame (>= pre_roll): render once, copy the rest.
    static_after_sec = max(effective_zoom, pre_roll)
    first_static = math.ceil(static_after_sec * fps)

    hash_key = render_cache_key(plan, clips_manifest, params)
    frames_root = resolve_path(args.frames_dir)
    frame_dir = frames_root / hash_key
    params["frame_dir"] = str(frame_dir)
    meta_path = frames_root / "latest.json"

    clips_by_key = build_clips_by_key(clips_manifest)
    missing_keys = sorted({a["candidateKey"] for a in plan["assignments"] if str(a["candidateKey"]) not in clips_by_key})
    if missing_keys:
        print(
            f"[warn] {len(missing_keys)} assignment key(s) have no clip; those cells stay background. "
            f"e.g. {missing_keys[0]}",
            flush=True,
        )

    opening_cell = int(plan["grid"].get("openingCell", 0))
    opening_rect = opening_cell_rect(plan, opening_cell)
    start_window = zoom_start_window(
        opening_rect, float(plan["grid"]["outputWidth"]), float(plan["grid"]["outputHeight"])
    )
    print(
        f"Canvas {params['canvas_w']}x{params['canvas_h']} @ {fps:g}fps, "
        f"zoom {effective_zoom:g}s (hold {params['zoom_hold']:g}s) + freeze {freeze:g}s "
        f"= {total_frames} frame(s)",
        flush=True,
    )
    print(
        f"Opening cell {opening_cell} -> start window {tuple(round(v, 1) for v in start_window)}",
        flush=True,
    )

    if args.preview_poster:
        ctx = build_context(plan, clips_manifest, params)
        ctx.frame_dir.mkdir(parents=True, exist_ok=True)
        preview_index = min(max(0, first_static), total_frames - 1)
        frame_path = render_frame(ctx, preview_index)
        write_poster(frame_path, poster_path, args.poster_width, args.poster_quality)
        print(f"Wrote preview poster {rel(poster_path)}")
        return 0

    # Cache hit: same render hash and both outputs already present.
    if not args.force and meta_path.exists():
        try:
            previous = read_json(meta_path)
        except (OSError, json.JSONDecodeError):
            previous = {}
        if (
            previous.get("renderHash") == hash_key
            and out_path.exists()
            and poster_path.exists()
        ):
            print(f"Render cache hit: {rel(out_path)}")
            return 0

    frame_dir.mkdir(parents=True, exist_ok=True)

    dynamic_indices = list(range(0, min(first_static, total_frames)))
    # Resume: trust existing frames, but drop the highest-numbered one (it may
    # have been partially written when a previous run was interrupted).
    existing = [i for i in dynamic_indices if valid_frame(frame_file_for(frame_dir, i))]
    if existing and len(existing) < len(dynamic_indices):
        newest = max(existing)
        frame_file_for(frame_dir, newest).unlink(missing_ok=True)
        existing.remove(newest)
        print(f"Resuming render: {len(existing)} dynamic frame(s) already done", flush=True)
    existing_set = set(existing)
    todo = [i for i in dynamic_indices if i not in existing_set]

    started = time.time()
    if todo:
        if args.workers <= 1:
            ctx = build_context(plan, clips_manifest, params)
            for done, frame_index in enumerate(todo, start=1):
                render_frame(ctx, frame_index)
                if done == 1 or done == len(todo) or frame_index % int(fps) == 0:
                    print(
                        f"[render] frame {frame_index + 1}/{total_frames} "
                        f"(t={frame_index / fps:.2f}s) [{done}/{len(todo)}]",
                        flush=True,
                    )
        else:
            chunks = chunk_indices(todo, args.workers)
            print(f"[render] {len(todo)} frame(s) across {len(chunks)} worker chunk(s)", flush=True)
            with ProcessPoolExecutor(
                max_workers=args.workers,
                initializer=_init_worker,
                initargs=(str(plan_path), str(clips_path), params),
            ) as pool:
                futures = {pool.submit(_render_chunk, chunk): chunk for chunk in chunks}
                for future in as_completed(futures):
                    lo, hi, elapsed = future.result()
                    print(f"[render] chunk frames {lo + 1}..{hi + 1} done ({elapsed:.1f}s)", flush=True)
        print(f"[render] dynamic frames done in {time.time() - started:.1f}s", flush=True)
    else:
        print("[render] all dynamic frames cached", flush=True)

    # Static tail: render the held frame once, then copy it for the freeze.
    if first_static < total_frames:
        ctx = build_context(plan, clips_manifest, params)
        canonical = render_frame(ctx, first_static)
        for frame_index in range(first_static + 1, total_frames):
            shutil.copyfile(canonical, frame_file_for(frame_dir, frame_index))
        print(f"[render] held final mosaic for frames {first_static + 1}..{total_frames}", flush=True)

    encode_video(frame_dir, fps, out_path, params["crf"], params["preset"])
    write_poster(frame_file_for(frame_dir, total_frames - 1), poster_path, args.poster_width, args.poster_quality)

    write_json(
        meta_path,
        {
            "schemaVersion": 1,
            "renderHash": hash_key,
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "frameDir": rel(frame_dir),
            "outputVideoPath": rel(out_path),
            "posterPath": rel(poster_path),
            "canvas": [params["canvas_w"], params["canvas_h"]],
            "fps": fps,
            "totalFrames": total_frames,
            "renderDurationSec": render_duration,
            "effectiveZoomSec": effective_zoom,
            "zoomHoldSec": params["zoom_hold"],
            "freezeSec": freeze,
        },
    )
    print(f"Wrote {rel(out_path)}")
    print(f"Wrote {rel(poster_path)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print(exc, file=sys.stderr)
        if exc.stderr:
            print(exc.stderr, file=sys.stderr)
        raise SystemExit(exc.returncode)
