#!/usr/bin/env python3
"""Step 2: match indexed video frames to a grid mosaic.

This step is grid-only. It reads the frame-signature index from Step 1, samples
the reference image into grid cells, and writes a render-ready match plan.

The output keeps frame identity explicit: each cell points to a source video and
to the frame number in the Step 1 `fps=<sample_fps>` stream. Later extraction
must select by that frame number, not by timestamp seeking.
"""

from __future__ import annotations

import argparse
import json
import math
import sys
import time
from pathlib import Path
from typing import Any

cv2: Any = None
np: Any = None


SIG_GRID = 16
SIG_CHANNELS = 3
SIG_BYTES = SIG_GRID * SIG_GRID * SIG_CHANNELS

PIPELINE_ROOT = Path(__file__).resolve().parent
REPO_ROOT = PIPELINE_ROOT.parent
DATA_DIR = PIPELINE_ROOT / "data"
INDEX_DIR = DATA_DIR / "index"
MANIFEST_PATH = INDEX_DIR / "manifest.json"
SIGNATURES_PATH = INDEX_DIR / "signatures.bin"
SYNC_REPORT_PATH = DATA_DIR / "step1-sync-report.json"
DEFAULT_PLAN_PATH = DATA_DIR / "matches" / "grid-plan.json"
DEFAULT_REFERENCE = REPO_ROOT / "reference.png"


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


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def rel(path: Path) -> str:
    try:
        return path.resolve().relative_to(PIPELINE_ROOT.resolve()).as_posix()
    except ValueError:
        try:
            return path.resolve().relative_to(REPO_ROOT.resolve()).as_posix()
        except ValueError:
            return str(path)


def load_index() -> tuple[dict[str, Any], np.ndarray]:
    if not MANIFEST_PATH.exists() or not SIGNATURES_PATH.exists():
        raise SystemExit("Missing index. Run python3 01-sync-and-index.py first.")
    manifest = json.loads(MANIFEST_PATH.read_text())
    raw = np.fromfile(SIGNATURES_PATH, dtype=np.uint8)
    expected = int(manifest["frameCount"]) * SIG_BYTES
    if raw.size != expected:
        raise SystemExit(
            f"Signature blob has {raw.size} bytes; expected {expected}. "
            "Re-run python3 01-sync-and-index.py."
        )
    sigs = raw.reshape(int(manifest["frameCount"]), SIG_GRID, SIG_GRID, SIG_CHANNELS)
    return manifest, sigs.astype(np.float32)


def downsample_signatures(sig16: np.ndarray, grid: int) -> np.ndarray:
    if grid == SIG_GRID:
        return sig16.reshape(sig16.shape[0], -1)
    factor = SIG_GRID // grid
    return sig16.reshape(sig16.shape[0], grid, factor, grid, factor, 3).mean(
        axis=(2, 4)
    ).reshape(sig16.shape[0], -1)


def luma_std(rgb: np.ndarray) -> np.ndarray:
    lum = 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]
    return lum.reshape(rgb.shape[0], -1).std(axis=1)


def build_frame_maps(manifest: dict[str, Any], total_frames: int) -> tuple[np.ndarray, np.ndarray]:
    video_by_global = np.zeros(total_frames, np.int32)
    local_by_global = np.zeros(total_frames, np.int32)
    for video_index, video in enumerate(manifest["videos"]):
        offset = int(video["frameOffset"])
        count = int(video["frameCount"])
        video_by_global[offset : offset + count] = video_index
        local_by_global[offset : offset + count] = np.arange(count, dtype=np.int32)
    return video_by_global, local_by_global


def parse_video_indices(value: str | None) -> set[int]:
    indices: set[int] = set()
    if not value:
        return indices
    for item in value.split(","):
        token = item.strip()
        if not token:
            continue
        if "-" in token:
            start_text, end_text = token.split("-", 1)
            if start_text.strip().isdigit() and end_text.strip().isdigit():
                start = int(start_text)
                end = int(end_text)
                step = 1 if start <= end else -1
                indices.update(range(start, end + step, step))
                continue
        indices.add(int(token))
    return indices


def video_indices_from_selectors(
    manifest: dict[str, Any],
    video_indices: str | None,
    video_ids: str | None,
) -> list[int]:
    selected = parse_video_indices(video_indices)
    if video_ids:
        needles = [item.strip().lower() for item in video_ids.split(",") if item.strip()]
        for index, video in enumerate(manifest["videos"]):
            haystack = f"{video.get('videoId', '')} {video.get('path', '')}".lower()
            if any(needle in haystack for needle in needles):
                selected.add(index)
    return sorted(index for index in selected if 0 <= index < len(manifest["videos"]))


def selected_video_indices(args: argparse.Namespace, manifest: dict[str, Any]) -> list[int] | None:
    selected = video_indices_from_selectors(manifest, args.video_indices, args.video_ids)
    if args.max_videos is not None and not selected:
        selected = list(range(min(args.max_videos, len(manifest["videos"]))))
    if not selected:
        return None
    return selected


def opening_video_indices(args: argparse.Namespace, manifest: dict[str, Any]) -> list[int] | None:
    selected = video_indices_from_selectors(
        manifest,
        args.opening_video_indices,
        args.opening_video_ids,
    )
    if not selected:
        if args.opening_video_indices or args.opening_video_ids:
            raise SystemExit("No videos matched --opening-video-indices/--opening-video-ids.")
        return None
    return selected


def local_import_video_indices(manifest: dict[str, Any]) -> list[int]:
    if not SYNC_REPORT_PATH.exists():
        raise SystemExit(
            "Missing local sync report. Run python3 01-sync-and-index.py "
            "or pass explicit neighborhood video selectors."
        )
    report = json.loads(SYNC_REPORT_PATH.read_text())
    local = report.get("local") or {}
    local_hashes = {
        str(item.get("contentHash"))
        for key in ("imported", "duplicates")
        for item in local.get(key, [])
        if item.get("contentHash")
    }
    selected = [
        index
        for index, video in enumerate(manifest["videos"])
        if str(video.get("contentHash")) in local_hashes
    ]
    if not selected:
        raise SystemExit("No indexed videos matched local imports from the Step 1 sync report.")
    return selected


def opening_neighborhood_video_indices(
    args: argparse.Namespace,
    manifest: dict[str, Any],
) -> list[int] | None:
    selected = set(
        video_indices_from_selectors(
            manifest,
            args.opening_neighborhood_video_indices,
            args.opening_neighborhood_video_ids,
        )
    )
    if args.opening_neighborhood_local:
        selected.update(local_import_video_indices(manifest))
    if not selected:
        if args.opening_neighborhood_video_indices or args.opening_neighborhood_video_ids:
            raise SystemExit("No videos matched opening-neighborhood video selectors.")
        return None
    return sorted(selected)


def derive_grid(args: argparse.Namespace, ref_w: int, ref_h: int) -> tuple[int, int]:
    if args.cells:
        aspect = ref_w / ref_h
        cols = max(1, round(math.sqrt(args.cells * aspect)))
        rows = max(1, round(args.cells / cols))
        return cols, rows
    if args.cols and args.rows:
        return int(args.cols), int(args.rows)
    if args.cols:
        return int(args.cols), max(1, round(int(args.cols) * ref_h / ref_w))
    if args.rows:
        return max(1, round(int(args.rows) * ref_w / ref_h)), int(args.rows)
    if args.cell_px:
        cols = max(1, round(ref_w / args.cell_px))
        rows = max(1, round(ref_h / args.cell_px))
        return cols, rows
    aspect = ref_w / ref_h
    cols = 96
    rows = max(1, round(cols / aspect))
    return cols, rows


def derive_output_size(args: argparse.Namespace, ref_w: int, ref_h: int, cols: int, rows: int) -> tuple[int, int]:
    if args.output_width and args.output_height:
        return int(args.output_width), int(args.output_height)
    if args.output_width:
        return int(args.output_width), max(1, round(int(args.output_width) * ref_h / ref_w))
    if args.output_height:
        return max(1, round(int(args.output_height) * ref_w / ref_h)), int(args.output_height)
    tile_px = int(args.output_tile_px or 40)
    return cols * tile_px, rows * tile_px


def reference_cell_signatures(reference_path: Path, cols: int, rows: int, grid: int) -> np.ndarray:
    ref = cv2.imread(str(reference_path), cv2.IMREAD_COLOR)
    if ref is None:
        raise SystemExit(f"Could not read reference image: {reference_path}")
    ref_small = cv2.resize(ref, (cols * grid, rows * grid), interpolation=cv2.INTER_AREA)
    cells = np.empty((rows * cols, grid * grid * 3), np.float32)
    for row in range(rows):
        for col in range(cols):
            block = ref_small[row * grid : (row + 1) * grid, col * grid : (col + 1) * grid]
            cells[row * cols + col] = block[:, :, ::-1].astype(np.float32).reshape(-1)
    return cells


def opening_cell(cols: int, rows: int, focus_x: float, focus_y: float) -> int:
    col = min(cols - 1, max(0, round((cols - 1) * focus_x)))
    row = min(rows - 1, max(0, round((rows - 1) * focus_y)))
    return row * cols + col


def opening_neighborhood_cells(cols: int, rows: int, args: argparse.Namespace) -> list[int]:
    radius = max(0, int(args.opening_neighborhood_radius or 0))
    if radius <= 0:
        return []
    center = opening_cell(cols, rows, args.focus_x, args.focus_y)
    center_row, center_col = divmod(center, cols)
    cells: list[int] = []
    for row in range(max(0, center_row - radius), min(rows, center_row + radius + 1)):
        for col in range(max(0, center_col - radius), min(cols, center_col + radius + 1)):
            cells.append(row * cols + col)
    cells.sort(key=lambda cell: (max(abs(divmod(cell, cols)[0] - center_row), abs(divmod(cell, cols)[1] - center_col)), cell))
    return cells


def cell_order(cells: np.ndarray, cols: int, rows: int, args: argparse.Namespace) -> np.ndarray:
    neighborhood = opening_neighborhood_cells(cols, rows, args)
    if neighborhood:
        rest = [cell for cell in range(rows * cols) if cell not in set(neighborhood)]
        return np.array([*neighborhood, *rest], dtype=np.int64)
    if args.order == "center-first" or args.opening_video_indices or args.opening_video_ids:
        first = opening_cell(cols, rows, args.focus_x, args.focus_y)
        rest = [cell for cell in range(rows * cols) if cell != first]
        return np.array([first, *rest], dtype=np.int64)
    return np.argsort(-cells.std(axis=1))


def choose_match(
    distances: np.ndarray,
    clean_ssd: float,
    cand_k: int,
    tile_lstd: np.ndarray,
    cell_lstd: float,
) -> int:
    finite = np.isfinite(distances)
    if not finite.any():
        return -1
    if clean_ssd <= 0:
        return int(np.argmin(distances))
    k = min(max(1, cand_k), distances.size)
    candidates = np.argpartition(distances, k - 1)[:k]
    candidates = candidates[np.isfinite(distances[candidates])]
    if candidates.size == 0:
        return int(np.argmin(distances))
    best_distance = distances[candidates].min()
    good = candidates[distances[candidates] <= best_distance + clean_ssd]
    return int(good[np.argmin(np.abs(tile_lstd[good] - cell_lstd))])


def match_cells(
    args: argparse.Namespace,
    manifest: dict[str, Any],
    signatures: np.ndarray,
    cells: np.ndarray,
    cols: int,
    rows: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray, dict[str, Any]]:
    total_frames = signatures.shape[0]
    fps = float(manifest["sampleFps"])
    video_by_global, local_by_global = build_frame_maps(manifest, total_frames)

    grid = int(args.match_grid)
    coarse = downsample_signatures(signatures, grid)
    signature_lstd = luma_std(signatures)
    selected = selected_video_indices(args, manifest)
    opening_selected = opening_video_indices(args, manifest)
    neighborhood_selected = opening_neighborhood_video_indices(args, manifest)
    video_ok = (
        np.ones(total_frames, dtype=bool)
        if selected is None
        else np.isin(video_by_global, np.array(selected, dtype=np.int32))
    )
    preroll_ok = (
        local_by_global >= int(math.ceil(args.pre_roll_sec * fps))
        if args.require_full_preroll
        else np.ones(total_frames, dtype=bool)
    )
    keep = np.where((signature_lstd >= args.flatness_min) & video_ok & preroll_ok)[0]
    if keep.size == 0:
        raise SystemExit("No usable frame candidates after filters.")

    tiles = coarse[keep]
    tile_sq = (tiles * tiles).sum(axis=1)
    tile_rgb = tiles.reshape(-1, grid, grid, 3)
    tile_lstd = luma_std(tile_rgb)
    cell_rgb = cells.reshape(cells.shape[0], grid, grid, 3)
    cell_lstd = luma_std(cell_rgb)
    clean_ssd = (grid * grid * 3) * (args.clean_rms**2)
    sim_ssd = (grid * grid * 3) * (args.sim_rms**2)
    exclude_window = int(round(args.exclude_sec * fps))

    pool_video = video_by_global[keep]
    pool_local = local_by_global[keep]
    opening_video_ok = (
        None
        if opening_selected is None
        else np.isin(pool_video, np.array(opening_selected, dtype=np.int32))
    )
    neighborhood_video_ok = (
        None
        if neighborhood_selected is None
        else np.isin(pool_video, np.array(neighborhood_selected, dtype=np.int32))
    )
    use_counts = np.zeros(tiles.shape[0], np.int32)
    temporally_blocked = np.zeros(tiles.shape[0], bool)
    assignments = np.full(cells.shape[0], -1, np.int64)
    errors = np.full(cells.shape[0], np.inf, np.float32)
    relax_levels = np.zeros(cells.shape[0], np.int8)
    placed_pool_tile = np.full(cells.shape[0], -1, np.int64)
    order = cell_order(cells, cols, rows, args)
    min_dist = max(0, int(args.min_dist))
    offsets = [
        (dr, dc)
        for dr in range(-min_dist, min_dist + 1)
        for dc in range(-min_dist, min_dist + 1)
        if dr * dr + dc * dc <= min_dist * min_dist and not (dr == 0 and dc == 0)
    ]
    opening_cell_index = opening_cell(cols, rows, args.focus_x, args.focus_y)
    neighborhood_cell_set = set(opening_neighborhood_cells(cols, rows, args))
    progress_every = max(1, len(order) // 20)
    started = time.time()

    for order_index, cell_index_raw in enumerate(order):
        cell_index = int(cell_index_raw)
        row, col = divmod(cell_index, cols)
        cell = cells[cell_index]
        base = tile_sq - 2.0 * (tiles @ cell) + float(cell @ cell)
        if neighborhood_video_ok is not None and cell_index in neighborhood_cell_set:
            base = base.copy()
            base[~neighborhood_video_ok] = np.inf
        if opening_video_ok is not None and cell_index == opening_cell_index:
            base = base.copy()
            base[~opening_video_ok] = np.inf

        spatial_blocked: set[int] = set()
        if offsets:
            for dr, dc in offsets:
                rr, cc = row + dr, col + dc
                if 0 <= rr < rows and 0 <= cc < cols:
                    pool_tile = int(placed_pool_tile[rr * cols + cc])
                    if pool_tile >= 0:
                        spatial_blocked.add(pool_tile)

        chosen = -1
        chosen_level = 0
        chosen_distances = base
        for level in range(4):
            distances = base.copy()
            if args.reuse_cap > 0 and level < 3:
                distances[use_counts >= args.reuse_cap] = np.inf
            if level < 2 and temporally_blocked.any():
                distances[temporally_blocked] = np.inf
            if level < 1:
                for tile_index in spatial_blocked:
                    distances[tile_index] = np.inf
            chosen = choose_match(
                distances,
                clean_ssd=clean_ssd,
                cand_k=args.cand_k,
                tile_lstd=tile_lstd,
                cell_lstd=float(cell_lstd[cell_index]),
            )
            if chosen >= 0:
                chosen_level = level
                chosen_distances = distances
                break
        if chosen < 0:
            raise RuntimeError(f"No candidate found for cell {cell_index}")

        global_frame = int(keep[chosen])
        assignments[cell_index] = global_frame
        errors[cell_index] = float(chosen_distances[chosen])
        relax_levels[cell_index] = chosen_level
        placed_pool_tile[cell_index] = chosen
        use_counts[chosen] += 1

        near = np.where(
            (pool_video == pool_video[chosen])
            & (np.abs(pool_local - pool_local[chosen]) <= exclude_window)
        )[0]
        if near.size:
            delta = tiles[near] - tiles[chosen]
            ssd = np.einsum("ij,ij->i", delta, delta)
            similar = near[ssd < sim_ssd]
            temporally_blocked[similar[similar != chosen]] = True

        matched = order_index + 1
        if matched == 1 or matched == len(order) or matched % progress_every == 0:
            elapsed = time.time() - started
            print(
                f"[match] {matched}/{len(order)} "
                f"({matched / len(order) * 100:.1f}%) "
                f"unique={len(set(assignments[assignments >= 0].tolist()))} "
                f"elapsed={elapsed:.1f}s",
                flush=True,
            )

    stats = {
        "candidateFrames": int(keep.size),
        "totalIndexedFrames": int(total_frames),
        "distinctFramesUsed": int(len(set(assignments.tolist()))),
        "selectedVideoIndices": selected,
        "openingVideoIndices": opening_selected,
        "openingNeighborhoodVideoIndices": neighborhood_selected,
        "openingNeighborhoodRadius": int(args.opening_neighborhood_radius or 0),
        "openingNeighborhoodCells": sorted(neighborhood_cell_set),
        "relaxedCells": int(np.count_nonzero(relax_levels)),
        "relaxLevelCounts": {
            str(level): int(np.count_nonzero(relax_levels == level)) for level in range(4)
        },
        "meanError": float(np.mean(errors)),
        "medianError": float(np.median(errors)),
        "maxError": float(np.max(errors)),
    }
    return assignments, errors, relax_levels, stats


def write_plan(
    args: argparse.Namespace,
    manifest: dict[str, Any],
    assignments: np.ndarray,
    errors: np.ndarray,
    relax_levels: np.ndarray,
    stats: dict[str, Any],
    cols: int,
    rows: int,
    reference_path: Path,
) -> None:
    fps = float(manifest["sampleFps"])
    video_by_global, local_by_global = build_frame_maps(manifest, int(manifest["frameCount"]))
    usage: dict[int, int] = {}
    for global_frame in assignments.tolist():
        usage[global_frame] = usage.get(global_frame, 0) + 1

    def frame_record(global_frame: int) -> dict[str, Any]:
        video_index = int(video_by_global[global_frame])
        frame_index = int(local_by_global[global_frame])
        video = manifest["videos"][video_index]
        return {
            "globalFrame": global_frame,
            "videoIndex": video_index,
            "videoId": video["videoId"],
            "sourcePath": video["path"],
            "sourceHash": video["contentHash"],
            "sourceWidth": video.get("width"),
            "sourceHeight": video.get("height"),
            "frameIndex": frame_index,
            "frameTimeSec": frame_index / fps,
            "candidateKey": f"{video['videoId']}_{frame_index:06d}",
        }

    assignments_json: list[dict[str, Any]] = []
    for cell_index, global_frame in enumerate(assignments.tolist()):
        frame = frame_record(int(global_frame))
        row, col = divmod(cell_index, cols)
        assignments_json.append(
            {
                "cellIndex": cell_index,
                "row": row,
                "col": col,
                "x": col * (args.output_width / cols),
                "y": row * (args.output_height / rows),
                "w": args.output_width / cols,
                "h": args.output_height / rows,
                "matchError": float(errors[cell_index]),
                "relaxLevel": int(relax_levels[cell_index]),
                **frame,
            }
        )

    used_frames = [
        {**frame_record(global_frame), "uses": count}
        for global_frame, count in sorted(usage.items())
    ]
    plan = {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "referencePath": rel(reference_path),
        "index": {
            "manifestPath": rel(MANIFEST_PATH),
            "signaturesPath": rel(SIGNATURES_PATH),
            "sampleFps": fps,
            "frameCount": int(manifest["frameCount"]),
            "videoCount": len(manifest["videos"]),
        },
        "grid": {
            "layout": "grid",
            "cols": cols,
            "rows": rows,
            "cellCount": cols * rows,
            "outputWidth": args.output_width,
            "outputHeight": args.output_height,
            "cellWidth": args.output_width / cols,
            "cellHeight": args.output_height / rows,
            "focusX": args.focus_x,
            "focusY": args.focus_y,
            "openingCell": opening_cell(cols, rows, args.focus_x, args.focus_y),
        },
        "timing": {
            "fps": args.fps,
            "tileFps": args.tile_fps,
            "preRollSec": args.pre_roll_sec,
            "freezeSec": args.freeze_sec,
        },
        "matching": {
            "matchGrid": args.match_grid,
            "order": args.order,
            "reuseCap": args.reuse_cap,
            "minDist": args.min_dist,
            "excludeSec": args.exclude_sec,
            "simRms": args.sim_rms,
            "flatnessMin": args.flatness_min,
            "cleanRms": args.clean_rms,
            "candK": args.cand_k,
            "requireFullPreroll": args.require_full_preroll,
            "openingVideoIndices": args.opening_video_indices,
            "openingVideoIds": args.opening_video_ids,
            "openingNeighborhoodRadius": args.opening_neighborhood_radius,
            "openingNeighborhoodLocal": args.opening_neighborhood_local,
            "openingNeighborhoodVideoIndices": args.opening_neighborhood_video_indices,
            "openingNeighborhoodVideoIds": args.opening_neighborhood_video_ids,
        },
        "stats": stats,
        "assignments": assignments_json,
        "usedFrames": used_frames,
    }
    out_path = Path(args.out)
    if not out_path.is_absolute():
        out_path = PIPELINE_ROOT / out_path
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(plan, indent=2) + "\n")
    print(f"Wrote {rel(out_path)}")


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reference", default=str(DEFAULT_REFERENCE), help="reference image")
    parser.add_argument("--out", default=str(DEFAULT_PLAN_PATH), help="match plan output path")
    parser.add_argument("--cols", type=int, default=None, help="grid columns")
    parser.add_argument("--rows", type=int, default=None, help="grid rows")
    parser.add_argument("--cells", type=int, default=None, help="target total cells from reference aspect")
    parser.add_argument("--cell-px", type=int, default=None, help="derive cols/rows from output size")
    parser.add_argument("--output-width", type=int, default=None)
    parser.add_argument("--output-height", type=int, default=None)
    parser.add_argument("--output-tile-px", type=int, default=40, help="default output pixels per grid cell")
    parser.add_argument("--fps", type=int, default=30, help="final video FPS")
    parser.add_argument("--tile-fps", type=int, default=30, help="tile clip FPS for later extraction")
    parser.add_argument("--pre-roll-sec", type=float, default=28.0)
    parser.add_argument("--freeze-sec", type=float, default=4.0)
    parser.add_argument("--focus-x", type=float, default=0.5)
    parser.add_argument("--focus-y", type=float, default=0.5)
    parser.add_argument("--order", choices=["distinctive", "center-first"], default="distinctive")
    parser.add_argument("--reuse-cap", type=int, default=20, help="max uses per exact frame; 0 = unlimited")
    parser.add_argument("--min-dist", type=int, default=4, help="min cell distance for exact-frame repeats")
    parser.add_argument("--exclude-sec", type=float, default=3.0, help="same-video near-duplicate window")
    parser.add_argument("--sim-rms", type=float, default=12.0, help="RMS threshold for near-duplicate blocking")
    parser.add_argument("--flatness-min", type=float, default=0.0, help="drop too-flat signatures if > 0")
    parser.add_argument("--clean-rms", type=float, default=12.0, help="texture tiebreak radius; 0 disables")
    parser.add_argument("--cand-k", type=int, default=256, help="candidate pool for texture tiebreak")
    parser.add_argument("--match-grid", type=int, default=8, choices=[2, 4, 8, 16])
    parser.add_argument("--require-full-preroll", action="store_true")
    parser.add_argument("--video-indices", default=None, help="comma-separated manifest video indices")
    parser.add_argument("--video-ids", default=None, help="comma-separated video id/path substrings")
    parser.add_argument(
        "--opening-video-indices",
        "--center-video-indices",
        dest="opening_video_indices",
        default=None,
        help="comma-separated manifest video indices allowed for the opening/center cell",
    )
    parser.add_argument(
        "--opening-video-ids",
        "--center-video-ids",
        dest="opening_video_ids",
        default=None,
        help="comma-separated video id/path substrings allowed for the opening/center cell",
    )
    parser.add_argument(
        "--opening-neighborhood-radius",
        "--center-neighborhood-radius",
        dest="opening_neighborhood_radius",
        type=int,
        default=0,
        help="Chebyshev radius around the opening/center cell to match before the rest",
    )
    parser.add_argument(
        "--opening-neighborhood-local",
        "--center-neighborhood-local",
        dest="opening_neighborhood_local",
        action="store_true",
        help="restrict the opening/center neighborhood to videos imported from local sources",
    )
    parser.add_argument(
        "--opening-neighborhood-video-indices",
        "--center-neighborhood-video-indices",
        dest="opening_neighborhood_video_indices",
        default=None,
        help="comma-separated manifest video indices allowed for the opening/center neighborhood",
    )
    parser.add_argument(
        "--opening-neighborhood-video-ids",
        "--center-neighborhood-video-ids",
        dest="opening_neighborhood_video_ids",
        default=None,
        help="comma-separated video id/path substrings allowed for the opening/center neighborhood",
    )
    parser.add_argument("--max-videos", type=int, default=None)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv or sys.argv[1:])
    load_numeric_dependencies()
    reference_path = Path(args.reference)
    if not reference_path.is_absolute():
        reference_path = (PIPELINE_ROOT / reference_path).resolve()
        if not reference_path.exists():
            reference_path = (REPO_ROOT / args.reference).resolve()
    ref = cv2.imread(str(reference_path), cv2.IMREAD_COLOR)
    if ref is None:
        raise SystemExit(f"Could not read reference image: {reference_path}")
    ref_h, ref_w = ref.shape[:2]

    manifest, signatures = load_index()
    cols, rows = derive_grid(args, ref_w, ref_h)
    args.output_width, args.output_height = derive_output_size(args, ref_w, ref_h, cols, rows)
    print(
        f"Grid: {cols}x{rows} ({cols * rows} cells), "
        f"output={args.output_width}x{args.output_height}, reference={rel(reference_path)}",
        flush=True,
    )
    print(
        f"Index: {signatures.shape[0]} frames @ {manifest['sampleFps']}fps "
        f"from {len(manifest['videos'])} unique video(s)",
        flush=True,
    )

    cells = reference_cell_signatures(reference_path, cols, rows, args.match_grid)
    assignments, errors, relax_levels, stats = match_cells(
        args, manifest, signatures, cells, cols, rows
    )
    write_plan(args, manifest, assignments, errors, relax_levels, stats, cols, rows, reference_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
