#!/usr/bin/env python3
"""High-res photomosaic of reference.png from the FULL frame index.

Unlike the old 120-end-frame version, this matches every reference cell against
the entire pool of frames sampled from all source videos (pipeline/data/index,
built by 01-index-frames.py at 5 fps -> tens of thousands of candidates). It then
extracts each winning frame at full resolution and composites a 4K still.

  python build_mosaic.py [--cell 40] [--reuse-cap 4]

Source videos are pipeline/videos/* — the exact files mirrored to the Supabase
`knicks-clips/videos/` prefix (same bytes; read locally to avoid a 7.9GB
re-download). By default the output matches the reference image dimensions.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
PIPE = REPO / "pipeline"
INDEX_DIR = PIPE / "data" / "index"
REFERENCE = REPO / "reference.png"
TILE_CACHE = HERE / ".cache" / "tiles"
OUT = HERE / "output"

SIG_GRID = 16
COARSE = 8
FLATNESS_MIN = 10.0     # drop near-solid frames (black/letterbox/slates)


def load_index():
    manifest = json.loads((INDEX_DIR / "manifest.json").read_text())
    sigs = np.fromfile(INDEX_DIR / "signatures.bin", dtype=np.uint8)
    n = sigs.size // (SIG_GRID * SIG_GRID * 3)
    sigs = sigs[: n * SIG_GRID * SIG_GRID * 3].reshape(n, SIG_GRID, SIG_GRID, 3).astype(np.float32)
    return manifest, sigs


def coarse_and_mean(sig16: np.ndarray, grid: int = COARSE):
    """sig16: (N,16,16,3) -> match vectors (N, grid*grid*3) and lumStd (N,).

    grid=16 uses the FULL stored signature (no downsampling) so bright outliers
    aren't averaged away — they keep their full SSD weight, which stops a frame
    with bright specks from matching an otherwise-dark cell. grid=8 (or 4) trades
    that fidelity for speed by box-averaging the 16x16 signature down.
    """
    n = sig16.shape[0]
    if grid == SIG_GRID:
        coarse = sig16.reshape(n, -1)
    else:
        f = SIG_GRID // grid
        coarse = sig16.reshape(n, grid, f, grid, f, 3).mean(axis=(2, 4)).reshape(n, -1)
    lum = (0.299 * sig16[..., 0] + 0.587 * sig16[..., 1] + 0.114 * sig16[..., 2])
    lum_std = lum.reshape(n, -1).std(axis=1)
    return coarse, lum_std


def frame_owner(manifest, global_idx):
    """Map a global frame index to (video_record, local_frame_index)."""
    for v in manifest["videos"]:
        if v["frameOffset"] <= global_idx < v["frameOffset"] + v["frameCount"]:
            return v, global_idx - v["frameOffset"]
    return None, None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cols", type=int, default=None,
                    help="grid columns; default derives from reference width / cell")
    ap.add_argument("--rows", type=int, default=None,
                    help="grid rows; default derives from reference height / cell")
    ap.add_argument("--cell", type=int, default=40, help="output px per cell")
    ap.add_argument("--reuse-cap", type=int, default=3, help="max times a frame is used")
    ap.add_argument("--min-dist", type=int, default=4,
                    help="min cell distance between two uses of the same frame (anti-clustering)")
    ap.add_argument("--exclude-sec", type=float, default=3.0,
                    help="block frames within +/- this many seconds of a pick (same video)")
    ap.add_argument("--sim-rms", type=float, default=12.0,
                    help="within the exclude window, only block frames whose RGB RMS "
                         "difference from the pick is below this (0-255). Distinct-looking "
                         "frames in the window (e.g. a black cut) are kept.")
    ap.add_argument("--flatness-min", type=float, default=0.0,
                    help="drop frames with luma std below this (uniform slates). Default 0 keeps "
                         "ALL frames (incl. clean blacks) so nothing is thrown away.")
    ap.add_argument("--clean-rms", type=float, default=12.0,
                    help="texture/cleanliness tiebreak: among frames whose coarse color is within "
                         "this RMS (0-255) of the best match, pick the one whose own flatness best "
                         "matches the cell's. Flat cells -> clean flat tiles (kills random noise); "
                         "detailed cells -> detailed tiles. 0 disables (raw color argmin).")
    ap.add_argument("--cand-k", type=int, default=256,
                    help="candidate pool size for the cleanliness tiebreak (closest-color frames "
                         "considered before the flatness match).")
    ap.add_argument("--match-grid", type=int, default=8, choices=[2, 4, 8, 16],
                    help="resolution at which each tile/cell is color-matched. 16 = full stored "
                         "signature (no info loss; bright outliers keep full SSD weight, so dark "
                         "cells reject specky frames). 8 = box-averaged (faster, blurs outliers).")
    ap.add_argument("--workers", type=int, default=12)
    ap.add_argument("--reference", default=str(REFERENCE), help="reference image path")
    ap.add_argument("--out-name", default="mosaic.png", help="output filename in output/")
    ap.add_argument("--cells", type=int, default=None,
                    help="target total cell count; derives cols/rows from reference aspect")
    ap.add_argument("--tile-px", type=int, default=None,
                    help="output pixels per tile (decoupled from grid density; default = --cell)")
    ap.add_argument("--video-indices", default=None,
                    help="comma-separated manifest video indices to restrict the frame pool "
                         "to (e.g. '55,45,10,6,38'). Diagnostic: shrink/curate the pool.")
    ap.add_argument("--video-ids", default=None,
                    help="comma-separated substrings; keep only videos whose videoId/path "
                         "contains any of them. Combined with --video-indices (union).")
    ap.add_argument("--max-videos", type=int, default=None,
                    help="if set (and no explicit selection), keep only the first N videos.")
    args = ap.parse_args()

    ref = cv2.imread(args.reference)
    if ref is None:
        print(f"cannot read {args.reference}"); return 1
    print(f"reference: {args.reference} -> {args.out_name}")
    ref_h, ref_w = ref.shape[:2]
    if not (INDEX_DIR / "manifest.json").exists():
        print("no index yet — run pipeline/01-index-frames.py first"); return 1

    manifest, sig16 = load_index()
    fps = float(manifest["sampleFps"])
    print(f"index: {sig16.shape[0]} frames @ {fps}fps from {len(manifest['videos'])} videos")

    G = int(args.match_grid)
    coarse, lum_std = coarse_and_mean(sig16, G)
    print(f"matching at {G}x{G} ({G*G*3}-dim per tile)")

    # Per-tile (video index, local frame index) so we can exclude frames that are
    # within +/- exclude-sec of an already-picked frame in the SAME video — those
    # are effectively the same clip moment and shouldn't tile separately.
    N = sig16.shape[0]
    vid_all = np.zeros(N, np.int32)
    li_all = np.zeros(N, np.int32)
    for vi, v in enumerate(manifest["videos"]):
        o, fc = v["frameOffset"], v["frameCount"]
        vid_all[o:o + fc] = vi
        li_all[o:o + fc] = np.arange(fc)

    # Optional video-pool restriction (diagnostic: curate / shrink the pool).
    selected = None
    if args.video_indices or args.video_ids or args.max_videos:
        sel = set()
        if args.video_indices:
            sel.update(int(x) for x in args.video_indices.split(",") if x.strip())
        if args.video_ids:
            subs = [s.strip().lower() for s in args.video_ids.split(",") if s.strip()]
            for vi, v in enumerate(manifest["videos"]):
                hay = f"{v['videoId']} {v['path']}".lower()
                if any(s in hay for s in subs):
                    sel.add(vi)
        if not sel and args.max_videos:
            sel = set(range(min(args.max_videos, len(manifest["videos"]))))
        selected = sorted(sel)
        names = [manifest["videos"][i]["videoId"] for i in selected]
        print(f"video pool restricted to {len(selected)} videos: {', '.join(names)}")

    vid_ok = np.ones(N, bool) if selected is None else np.isin(vid_all, np.array(selected, np.int32))
    keep = np.where((lum_std >= args.flatness_min) & vid_ok)[0]
    print(f"usable after flatness filter: {keep.size} / {sig16.shape[0]}")
    if keep.size == 0:
        print("no usable frames after filters"); return 1
    T = coarse[keep]                                  # (K, G*G*3)
    T_sq = (T * T).sum(axis=1)                        # (K,)
    vid = vid_all[keep]
    li = li_all[keep]
    # Per-frame match-grid luma std for the cleanliness/texture tiebreak.
    T_rgb = T.reshape(-1, G, G, 3)
    T_lum = 0.299 * T_rgb[..., 0] + 0.587 * T_rgb[..., 1] + 0.114 * T_rgb[..., 2]
    T_lstd = T_lum.reshape(T.shape[0], -1).std(axis=1)   # (K,)
    clean_ssd = (G * G * 3) * (args.clean_rms ** 2)   # SSD margin for "color-tied"
    cand_k = min(int(args.cand_k), T.shape[0])
    win = int(round(args.exclude_sec * fps))          # +/- frames considered per pick
    sim_ssd = (G * G * 3) * (args.sim_rms ** 2)       # SSD threshold for "near-identical"
    print(f"temporal exclusion: +/-{args.exclude_sec}s ({win} frames), only blocking frames "
          f"within RMS {args.sim_rms}/255 of the pick")

    cell = args.cell
    if args.cells:                                    # target a cell count, keep ref aspect
        aspect = ref_w / ref_h
        cols = max(1, round((args.cells * aspect) ** 0.5))
        rows = max(1, round(args.cells / cols))
    else:
        cols = args.cols or max(1, round(ref_w / cell))
        rows = args.rows or max(1, round(ref_h / cell))
    tile_px = args.tile_px or cell                    # output px per tile (decoupled)
    outW, outH = cols * tile_px, rows * tile_px       # high-res output at ref aspect
    print(f"grid: {cols}x{rows} = {cols*rows} cells, tile {tile_px}px, output {outW}x{outH}")
    ref_small = cv2.resize(ref, (cols * G, rows * G), interpolation=cv2.INTER_AREA)
    M = rows * cols
    C = np.empty((M, G * G * 3), np.float32)
    for r in range(rows):
        for c in range(cols):
            blk = ref_small[r*G:(r+1)*G, c*G:(c+1)*G]
            C[r*cols + c] = blk[:, :, ::-1].astype(np.float32).reshape(-1)  # BGR->RGB

    # Per-cell match-grid luma std, so the tiebreak can match each cell's texture.
    C_rgb = C.reshape(M, G, G, 3)
    C_lum = 0.299 * C_rgb[..., 0] + 0.587 * C_rgb[..., 1] + 0.114 * C_rgb[..., 2]
    C_lstd = C_lum.reshape(M, -1).std(axis=1)         # (M,)

    # Greedy match: most-distinctive cells first, min SSD with a reuse cap so the
    # huge pool actually spreads across the grid.
    order = np.argsort(-C.std(axis=1))
    use = np.zeros(T.shape[0], np.int32)
    blocked = np.zeros(T.shape[0], bool)              # within +/-win of a pick
    assign = np.empty(M, np.int64)
    grid_tile = np.full(M, -1, np.int64)              # tile placed at each cell
    R = int(args.min_dist)
    offs = [(dr, dc) for dr in range(-R, R + 1) for dc in range(-R, R + 1)
            if dr * dr + dc * dc <= R * R and not (dr == 0 and dc == 0)]
    for ci in order:
        cr, cc = divmod(int(ci), cols)
        c = C[ci]
        d = T_sq - 2.0 * (T @ c) + (c @ c)            # SSD to every tile (BLAS gemv)
        d[use >= args.reuse_cap] = np.inf
        d[blocked] = np.inf                           # honor temporal exclusion
        # Spatial spread: forbid any tile already placed within min-dist cells, so
        # the same frame never clusters / repeats in a row near itself.
        for dr, dc in offs:
            rr, ccx = cr + dr, cc + dc
            if 0 <= rr < rows and 0 <= ccx < cols:
                tt = grid_tile[rr * cols + ccx]
                if tt >= 0:
                    d[tt] = np.inf
        if clean_ssd <= 0:
            t = int(np.argmin(d))
        else:
            # Cleanliness/texture tiebreak: take the closest-color candidates, keep
            # those within clean_ssd of the very best, then among them pick the frame
            # whose own flatness best matches this cell's. A flat cell (dark suit, sky,
            # white jersey) thus grabs a CLEAN flat tile instead of a color-equidistant
            # noisy one; a detailed cell still gets a detailed tile.
            cand = np.argpartition(d, cand_k - 1)[:cand_k]
            cand = cand[np.isfinite(d[cand])]
            if cand.size == 0:
                t = int(np.argmin(d))
            else:
                dmin = d[cand].min()
                good = cand[d[cand] <= dmin + clean_ssd]
                t = int(good[np.argmin(np.abs(T_lstd[good] - C_lstd[ci]))])
        assign[ci] = keep[t]                          # store GLOBAL frame index
        grid_tile[ci] = t
        use[t] += 1
        # Block frames within +/-win of this pick in the same video, but ONLY the
        # ones that also look near-identical to it (RGB SSD < sim_ssd). A visually
        # different frame in the window (black cut, scene change) stays available
        # for other cells; the pick itself may still repeat up to the reuse cap.
        near = np.where((vid == vid[t]) & (np.abs(li - li[t]) <= win))[0]
        if near.size:
            dd = T[near] - T[t]
            ssd = np.einsum("ij,ij->i", dd, dd)
            similar = near[ssd < sim_ssd]
            blocked[similar[similar != t]] = True
    print(f"matched {M} cells, {len(set(assign.tolist()))} distinct frames")

    # Extract each winning frame at tile resolution. Frame-ACCURATE: we replicate the
    # indexer's `fps=N` filter and select by frame NUMBER (eq(n,li)), so the rendered
    # tile is exactly the frame its signature represents. Timestamp seeking (-ss) was
    # keyframe-snapping across scene cuts and rendering bright frames where the match
    # picked a dark one (the source of the speckle). Batched: one decode per video.
    TILE_CACHE.mkdir(parents=True, exist_ok=True)
    needed = sorted(set(assign.tolist()))
    ex = max(96, tile_px * 2)                          # fixed-ish extract res, cache-reusable
    vf_geom = f"scale={ex}:{ex}:force_original_aspect_ratio=increase,crop={ex}:{ex}"
    # Group needed frames by owning video -> [(local_index, global_index), ...].
    by_video: dict[int, list[tuple[int, int]]] = {}
    for gidx in needed:
        dst = TILE_CACHE / f"{gidx}.jpg"
        if dst.exists() and dst.stat().st_size:
            continue
        v, li = frame_owner(manifest, gidx)
        if v is None:
            continue
        vi = next(i for i, vv in enumerate(manifest["videos"]) if vv is v)
        by_video.setdefault(vi, []).append((int(li), int(gidx)))
    lock = threading.Lock()
    done = [0]
    to_extract = sum(len(x) for x in by_video.values())

    def extract_video(item):
        vi, pairs = item
        v = manifest["videos"][vi]
        pairs.sort()                                   # frame-number order == ffmpeg output order
        lis = [li for li, _ in pairs]
        sel = "+".join(f"eq(n\\,{li})" for li in lis)
        vf = f"fps={fps},select='{sel}',{vf_geom}"
        tmp = TILE_CACHE / f"__v{vi}_%d.jpg"
        subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                        "-i", str(PIPE / v["path"]), "-vf", vf, "-vsync", "0",
                        "-frames:v", str(len(lis)), str(tmp)],
                       capture_output=True)
        for k, (_, gidx) in enumerate(pairs, start=1):  # ffmpeg numbers outputs from 1
            src = TILE_CACHE / f"__v{vi}_{k}.jpg"
            if src.exists():
                src.replace(TILE_CACHE / f"{gidx}.jpg")
        with lock:
            done[0] += len(lis)
            print(f"  extracted {done[0]}/{to_extract} tiles ({len(by_video)} videos)")

    print(f"extracting {to_extract} unique frames (frame-accurate) from {len(by_video)} videos...")
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        list(pool.map(extract_video, by_video.items()))

    # Composite at tile_px per cell (output = cols*tile_px x rows*tile_px).
    canvas = np.zeros((outH, outW, 3), np.uint8)
    cache = {}
    for r in range(rows):
        for c in range(cols):
            g = int(assign[r*cols + c])
            im = cache.get(g)
            if im is None:
                p = TILE_CACHE / f"{g}.jpg"
                t = cv2.imread(str(p)) if p.exists() else None
                im = cv2.resize(t, (tile_px, tile_px), interpolation=cv2.INTER_AREA) \
                    if t is not None else np.zeros((tile_px, tile_px, 3), np.uint8)
                cache[g] = im
            canvas[r*tile_px:(r+1)*tile_px, c*tile_px:(c+1)*tile_px] = im

    OUT.mkdir(parents=True, exist_ok=True)
    out_path = OUT / args.out_name
    poster_path = out_path.with_name(f"{out_path.stem}_poster.jpg")
    cv2.imwrite(str(out_path), canvas)
    poster_w = min(1920, outW)
    poster_h = max(1, int(round(poster_w * outH / outW)))
    poster = cv2.resize(canvas, (poster_w, poster_h), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(poster_path), poster, [cv2.IMWRITE_JPEG_QUALITY, 92])
    print(f"wrote {out_path} ({outW}x{outH}), {len(set(assign.tolist()))} distinct frames")
    print(f"wrote {poster_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
