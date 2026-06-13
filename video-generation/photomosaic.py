#!/usr/bin/env python3
"""Photomosaic of reference.png built ONLY from the clip end-frames in Supabase.

This is the still-image test of the mosaic pipeline: instead of rendering the
full mp4 (01-index -> 02-match -> 04-render), we reconstruct reference.png as a
grid whose every cell is the best-fitting clip end-frame. Tiles are pulled from
the Supabase `knicks-clips` bucket (frames/ prefix) — no local images are used.

Matching mirrors pipeline/02-match.mjs: each tile/cell is reduced to an 8x8 RGB
"coarse signature"; a cell takes the tile with the lowest SSD, plus a soft reuse
penalty so 120 tiles spread across the grid instead of repeating one.

  python photomosaic.py [--cols 64] [--rows 36] [--cell 48] [--reuse-weight 350]

Output: video-generation/output/mosaic.png
"""
from __future__ import annotations

import argparse
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import cv2
import numpy as np

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
sys.path.insert(0, str(REPO / "pipeline"))
import supabase_push  # noqa: E402

REFERENCE = REPO / "reference.png"
CACHE = HERE / ".cache" / "frames"
OUT = HERE / "output"
COARSE = 8  # 8x8 RGB coarse signature, matching downsampleSig() in the pipeline


def list_frames(sb) -> list[str]:
    names, off = [], 0
    while True:
        r = sb._sess.post(
            f"{sb.url}/storage/v1/object/list/{supabase_push.BUCKET}",
            json={"prefix": "frames", "limit": 1000, "offset": off,
                  "sortBy": {"column": "name", "order": "asc"}}, timeout=30)
        page = r.json() if r.status_code == 200 else []
        if not page:
            break
        names += [x["name"] for x in page if x.get("name", "").endswith(".jpg")]
        if len(page) < 1000:
            break
        off += 1000
    return names


def download_frames(sb, names: list[str]) -> list[Path]:
    CACHE.mkdir(parents=True, exist_ok=True)

    def fetch(name: str) -> Path | None:
        dst = CACHE / name
        if dst.exists() and dst.stat().st_size:
            return dst
        r = sb._sess.get(
            f"{sb.url}/storage/v1/object/{supabase_push.BUCKET}/frames/{name}",
            timeout=60)
        if r.status_code == 200:
            dst.write_bytes(r.content)
            return dst
        return None

    out = []
    with ThreadPoolExecutor(max_workers=12) as pool:
        for p in pool.map(fetch, names):
            if p:
                out.append(p)
    return out


def coarse_sig(img_bgr: np.ndarray) -> np.ndarray:
    """8x8 RGB mean signature as a flat float32 (192,)."""
    small = cv2.resize(img_bgr, (COARSE, COARSE), interpolation=cv2.INTER_AREA)
    return small[:, :, ::-1].astype(np.float32).reshape(-1)  # BGR->RGB, flatten


def center_crop_to(img: np.ndarray, aspect: float) -> np.ndarray:
    h, w = img.shape[:2]
    if w / h > aspect:                       # too wide -> crop width
        nw = int(round(h * aspect))
        x0 = (w - nw) // 2
        return img[:, x0:x0 + nw]
    nh = int(round(w / aspect))              # too tall -> crop height
    y0 = (h - nh) // 2
    return img[y0:y0 + nh, :]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--cols", type=int, default=64)
    ap.add_argument("--rows", type=int, default=36)
    ap.add_argument("--cell", type=int, default=48, help="output px per cell")
    ap.add_argument("--reuse-weight", type=float, default=350.0,
                    help="soft penalty per prior use of a tile (spreads tiles)")
    args = ap.parse_args()

    ref = cv2.imread(str(REFERENCE))
    if ref is None:
        print(f"cannot read {REFERENCE}")
        return 1
    cols, rows, cell = args.cols, args.rows, args.cell

    sb = supabase_push.client()
    if not sb.enabled:
        print("Supabase not configured")
        return 1
    names = list_frames(sb)
    print(f"Supabase frames: {len(names)}")
    paths = download_frames(sb, names)
    print(f"downloaded/cached: {len(paths)} tiles")
    if not paths:
        return 1

    # Tile signatures + the tile images themselves (kept small for compositing).
    tiles, tile_sig = [], []
    for p in paths:
        im = cv2.imread(str(p))
        if im is None:
            continue
        tiles.append(im)
        tile_sig.append(coarse_sig(im))
    tile_sig = np.stack(tile_sig)            # (N, 192)
    n = len(tiles)
    print(f"usable tiles: {n}")

    # Reference cell signatures: resize whole ref to (cols*8, rows*8); each 8x8
    # block is one cell's coarse signature (same reduction as the tiles).
    ref_small = cv2.resize(ref, (cols * COARSE, rows * COARSE), interpolation=cv2.INTER_AREA)
    cell_sigs = np.empty((rows * cols, COARSE * COARSE * 3), np.float32)
    for r in range(rows):
        for c in range(cols):
            block = ref_small[r*COARSE:(r+1)*COARSE, c*COARSE:(c+1)*COARSE]
            cell_sigs[r*cols + c] = block[:, :, ::-1].astype(np.float32).reshape(-1)

    # Match: per cell pick min SSD + soft reuse penalty. Hardest-to-match cells
    # (most saturated/distinct) go first so they get first pick of rare tiles.
    use_counts = np.zeros(n, np.float32)
    assign = np.empty(rows * cols, np.int32)
    spread = cell_sigs.std(axis=1)
    order = np.argsort(-spread)              # most distinctive cells first
    for cell_i in order:
        d = ((tile_sig - cell_sigs[cell_i]) ** 2).sum(axis=1)
        d = d + args.reuse_weight * use_counts
        t = int(d.argmin())
        assign[cell_i] = t
        use_counts[t] += 1

    # Composite.
    outW, outH = cols * cell, rows * cell
    canvas = np.empty((outH, outW, 3), np.uint8)
    cache = {}
    for r in range(rows):
        for c in range(cols):
            t = int(assign[r*cols + c])
            if t not in cache:
                crop = center_crop_to(tiles[t], 1.0)        # square cells
                cache[t] = cv2.resize(crop, (cell, cell), interpolation=cv2.INTER_AREA)
            canvas[r*cell:(r+1)*cell, c*cell:(c+1)*cell] = cache[t]

    OUT.mkdir(parents=True, exist_ok=True)
    out_path = OUT / "mosaic.png"
    cv2.imwrite(str(out_path), canvas)
    # A downscaled poster for quick viewing.
    poster = cv2.resize(canvas, (1920, int(1920 * outH / outW)), interpolation=cv2.INTER_AREA)
    cv2.imwrite(str(OUT / "mosaic_poster.jpg"), poster, [cv2.IMWRITE_JPEG_QUALITY, 90])
    print(f"{rows*cols} cells, {len(set(assign.tolist()))} distinct tiles used")
    print(f"wrote {out_path} ({outW}x{outH})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
