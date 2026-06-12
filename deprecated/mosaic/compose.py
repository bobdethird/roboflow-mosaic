"""Compose the final mosaic image from a tile assignment and report quality scores."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from skimage.metrics import peak_signal_noise_ratio, structural_similarity


_DEFAULT_FALLBACK_COLOR: tuple[int, int, int] = (255, 255, 255)


def compose_mosaic(
    tiles: np.ndarray,
    assignment: np.ndarray,
    grid_rows: int,
    grid_cols: int,
    fallback_color: tuple[int, int, int] = _DEFAULT_FALLBACK_COLOR,
) -> np.ndarray:
    """Assemble the mosaic canvas from per-cell tile assignments.

    Args:
        tiles: (M, tile_h, tile_w, 3) uint8 tile pool.
        assignment: (grid_rows*grid_cols,) int array; assignment[i] is the tile
            index for cell i in row-major order. A value of -1 means "no tile
            assigned" — that cell is filled with `fallback_color` instead. This
            happens when the reuse policy can't cover every cell (e.g. UNIQUE
            with fewer tiles than cells, or LIMITED with too-low max_repeats).
        grid_rows: number of cell rows in the mosaic.
        grid_cols: number of cell columns in the mosaic.
        fallback_color: RGB triple (uint8 range) used for unassigned cells.
            Defaults to plain white so blank regions stand out as "missing".

    Returns:
        mosaic: (grid_rows*tile_h, grid_cols*tile_w, 3) uint8 image.
    """
    expected = grid_rows * grid_cols
    if assignment.shape[0] != expected:
        raise ValueError(
            f"assignment has {assignment.shape[0]} entries, expected {expected} "
            f"for a {grid_rows}x{grid_cols} grid"
        )
    if tiles.ndim != 4 or tiles.shape[-1] != 3:
        raise ValueError(f"tiles must be (M, h, w, 3) uint8, got shape {tiles.shape}")

    _, tile_h, tile_w, _ = tiles.shape
    unfilled = assignment < 0
    if unfilled.any():
        gathered = np.empty((expected, tile_h, tile_w, 3), dtype=np.uint8)
        gathered[~unfilled] = tiles[assignment[~unfilled]]
        gathered[unfilled] = np.asarray(fallback_color, dtype=np.uint8)
    else:
        gathered = tiles[assignment]

    mosaic = (
        gathered.reshape(grid_rows, grid_cols, tile_h, tile_w, 3)
        .transpose(0, 2, 1, 3, 4)
        .reshape(grid_rows * tile_h, grid_cols * tile_w, 3)
    )
    return np.ascontiguousarray(mosaic)


@dataclass(frozen=True)
class QualityScores:
    psnr: float
    ssim: float

    def as_caption(self) -> str:
        return f"PSNR {self.psnr:.2f} dB | SSIM {self.ssim:.3f}"


def quality_scores(mosaic: np.ndarray, reference_canvas: np.ndarray) -> QualityScores:
    """Compute PSNR and SSIM between the mosaic and the resized reference canvas.

    Both inputs must have identical shape (`grid_rows*tile_h, grid_cols*tile_w, 3`)
    and be uint8.
    """
    if mosaic.shape != reference_canvas.shape:
        raise ValueError(
            f"shape mismatch: mosaic {mosaic.shape} vs reference {reference_canvas.shape}"
        )
    psnr = float(
        peak_signal_noise_ratio(reference_canvas, mosaic, data_range=255)
    )
    ssim = float(
        structural_similarity(
            reference_canvas,
            mosaic,
            channel_axis=2,
            data_range=255,
        )
    )
    return QualityScores(psnr=psnr, ssim=ssim)
