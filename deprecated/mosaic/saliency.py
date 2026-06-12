"""Saliency map computation and resampling to the mosaic grid.

We use OpenCV's classical StaticSaliencyFineGrained detector because it ships in
`opencv-contrib-python` and requires no external model weights. The contract is
intentionally narrow: an RGB uint8 image in, a (H, W) float32 map in [0, 1] out.
Swapping in a deep model later only requires replacing `compute_saliency`.
"""

from __future__ import annotations

import numpy as np

try:
    import cv2  # type: ignore[import-untyped]
except ImportError as e:  # pragma: no cover - import-time guard for clearer errors
    raise ImportError(
        "OpenCV with contrib modules is required for saliency. "
        "Install with: pip install opencv-contrib-python"
    ) from e


def compute_saliency(img_rgb: np.ndarray) -> np.ndarray:
    """Compute a fine-grained static saliency map for an RGB image.

    Args:
        img_rgb: (H, W, 3) uint8 RGB array.

    Returns:
        (H, W) float32 saliency map normalized into [0, 1].
    """
    if img_rgb.ndim != 3 or img_rgb.shape[2] != 3:
        raise ValueError(f"expected (H, W, 3) RGB array, got shape {img_rgb.shape}")
    if img_rgb.dtype != np.uint8:
        img_rgb = img_rgb.astype(np.uint8)

    bgr = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2BGR)
    detector = cv2.saliency.StaticSaliencyFineGrained_create()
    ok, sal = detector.computeSaliency(bgr)
    if not ok or sal is None:
        # Fall back to a uniform map so downstream code still works.
        return np.ones(img_rgb.shape[:2], dtype=np.float32)

    sal = sal.astype(np.float32)
    # OpenCV usually returns [0, 1] already, but normalize defensively.
    lo, hi = float(sal.min()), float(sal.max())
    if hi > lo:
        sal = (sal - lo) / (hi - lo)
    else:
        sal = np.zeros_like(sal)
    return sal


def resample_saliency(
    sal_map: np.ndarray,
    grid_rows: int,
    grid_cols: int,
    tile_h: int,
    tile_w: int,
) -> np.ndarray:
    """Resample a full-resolution saliency map onto the mosaic grid.

    The saliency map is first resized to the exact canvas size
    (grid_rows*tile_h, grid_cols*tile_w) and then split into per-cell patches so
    each cell carries the same shape as its tile, suitable for per-pixel weighting.

    Args:
        sal_map: (H, W) float32 saliency map.
        grid_rows, grid_cols: number of mosaic cells.
        tile_h, tile_w: tile dimensions in pixels.

    Returns:
        per_cell: (grid_rows*grid_cols, tile_h, tile_w) float32 array of saliency
            samples aligned with the cells produced by `prepare_reference`.
    """
    if sal_map.ndim != 2:
        raise ValueError(f"expected 2D saliency map, got shape {sal_map.shape}")

    canvas_w = grid_cols * tile_w
    canvas_h = grid_rows * tile_h
    # INTER_AREA is the right choice for downsampling, INTER_LINEAR for upsampling.
    interp = cv2.INTER_AREA if (canvas_h * canvas_w) < sal_map.size else cv2.INTER_LINEAR
    resized = cv2.resize(sal_map, (canvas_w, canvas_h), interpolation=interp).astype(
        np.float32, copy=False
    )

    per_cell = (
        resized.reshape(grid_rows, tile_h, grid_cols, tile_w)
        .transpose(0, 2, 1, 3)
        .reshape(grid_rows * grid_cols, tile_h, tile_w)
        .copy()
    )
    return per_cell


def per_cell_mean(per_cell_saliency: np.ndarray) -> np.ndarray:
    """Mean saliency value per cell, useful as a scalar weight or for priority sorting.

    Args:
        per_cell_saliency: (numCells, tile_h, tile_w) array from `resample_saliency`.

    Returns:
        (numCells,) float32 array of mean saliency per cell.
    """
    return per_cell_saliency.mean(axis=(1, 2)).astype(np.float32, copy=False)
