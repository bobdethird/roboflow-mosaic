"""Cost matrix construction and tile assignment for the mosaic builder.

Two pieces:
- `build_cost_matrix(cells, tiles, metric, saliency_per_cell)` builds an `(N, M)`
  cost matrix for either MSE or SSIM, optionally weighted by a per-pixel saliency
  map (per cell). MSE is vectorized via the `||a-b||^2 = ||a||^2 + ||b||^2 - 2 a.b`
  identity so we never materialize an `(N, M, h, w, C)` tensor. SSIM is a loop
  because skimage's SSIM has no batched form, but tiles are small so this is fine.
- `assign_tiles(cost, reuse, ...)` turns the cost matrix into a per-cell tile
  index according to the reuse policy (unlimited / limited / unique). Unique and
  limited use the Hungarian algorithm (scipy `linear_sum_assignment`) when feasible
  and fall back to greedy-with-capacity when the expanded matrix would be too big.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

import numpy as np
from scipy.optimize import linear_sum_assignment
from skimage.metrics import structural_similarity


class Metric(str, Enum):
    """Distance metric used to rank tiles against a reference cell."""

    MSE = "MSE"
    SSIM = "SSIM"


class ReusePolicy(str, Enum):
    """How often a single tile photo may appear in the final mosaic."""

    UNLIMITED = "Unlimited"
    LIMITED = "Limited"
    UNIQUE = "Unique"


SALIENCY_FLOOR = 0.15
"""Minimum per-pixel weight even when saliency is zero. Keeps non-salient regions
contributing some signal so the mosaic doesn't collapse to a featureless backdrop."""


def _saliency_weights(saliency_per_cell: np.ndarray) -> np.ndarray:
    """Floor-and-stretch raw saliency into [SALIENCY_FLOOR, 1.0] per pixel."""
    return (SALIENCY_FLOOR + (1.0 - SALIENCY_FLOOR) * saliency_per_cell).astype(
        np.float32, copy=False
    )


# ---------------------------------------------------------------------------
# MSE cost
# ---------------------------------------------------------------------------


def _mse_cost_uniform(cells: np.ndarray, tiles: np.ndarray) -> np.ndarray:
    """Vectorized per-pixel MSE cost using the squared-norm expansion."""
    N, h, w, C = cells.shape
    M = tiles.shape[0]
    P = h * w * C
    cells_f = (cells.astype(np.float32) / 255.0).reshape(N, P)
    tiles_f = (tiles.astype(np.float32) / 255.0).reshape(M, P)
    cells_sq = np.einsum("ij,ij->i", cells_f, cells_f)
    tiles_sq = np.einsum("ij,ij->i", tiles_f, tiles_f)
    dot = cells_f @ tiles_f.T
    cost = cells_sq[:, None] + tiles_sq[None, :] - 2.0 * dot
    cost /= P
    np.maximum(cost, 0.0, out=cost)
    return cost.astype(np.float32, copy=False)


def _mse_cost_weighted(
    cells: np.ndarray,
    tiles: np.ndarray,
    weights_per_cell: np.ndarray,
) -> np.ndarray:
    """Per-pixel saliency-weighted MSE.

    For each cell `i`, tile `j`, pixel `p`, channel `c`:
        cost[i, j] = sum_{p, c} w[i, p] * (a[i, p, c] - b[j, p, c])^2  /  (sum_p w[i,p] * C)

    Expanded the same way as `_mse_cost_uniform` so we never allocate an
    `(N, M, h, w, C)` tensor:
        cost[i, j] = ( sum_p w[i,p] * a_sq[i,p]
                     + sum_p w[i,p] * b_sq[j,p]
                     - 2 * sum_{p,c} (w[i,p]*a[i,p,c]) * b[j,p,c] ) / w_total[i]
    """
    N, h, w, C = cells.shape
    M = tiles.shape[0]
    P_pix = h * w
    cells_f = cells.astype(np.float32) / 255.0
    tiles_f = tiles.astype(np.float32) / 255.0
    cells_pix = cells_f.reshape(N, P_pix, C)
    tiles_pix = tiles_f.reshape(M, P_pix, C)
    weights_flat = weights_per_cell.reshape(N, P_pix).astype(np.float32, copy=False)

    w_sum = weights_flat.sum(axis=1) * C
    w_sum = np.maximum(w_sum, 1e-8)

    cells_pix_sq = (cells_pix * cells_pix).sum(axis=-1)
    tiles_pix_sq = (tiles_pix * tiles_pix).sum(axis=-1)

    W_cells_sq = (weights_flat * cells_pix_sq).sum(axis=1)
    W_tiles_sq = weights_flat @ tiles_pix_sq.T

    cells_pix_w = cells_pix * weights_flat[:, :, None]
    dot = cells_pix_w.reshape(N, P_pix * C) @ tiles_pix.reshape(M, P_pix * C).T

    cost = (W_cells_sq[:, None] + W_tiles_sq - 2.0 * dot) / w_sum[:, None]
    np.maximum(cost, 0.0, out=cost)
    return cost.astype(np.float32, copy=False)


# ---------------------------------------------------------------------------
# SSIM cost
# ---------------------------------------------------------------------------


def _ssim_cost(
    cells: np.ndarray,
    tiles: np.ndarray,
    weights_per_cell: np.ndarray | None = None,
) -> np.ndarray:
    """SSIM-based cost matrix; `cost = 1 - SSIM`.

    Skimage's SSIM doesn't have a batched form, so we loop. Tiles are small
    (~32 px) so this stays manageable. When saliency weights are provided we use
    `full=True` to get the per-pixel SSIM map and take a saliency-weighted mean
    instead of the plain mean.
    """
    N, h, w, _ = cells.shape
    M = tiles.shape[0]
    cost = np.empty((N, M), dtype=np.float32)

    # SSIM window must be odd and <= min spatial dim. Default 7 is fine for >=7px tiles.
    win_size = min(7, h, w)
    if win_size % 2 == 0:
        win_size -= 1
    win_size = max(win_size, 3)

    for i in range(N):
        cell = cells[i]
        w_pixel = None if weights_per_cell is None else weights_per_cell[i]
        if w_pixel is not None:
            w_sum_i = float(w_pixel.sum())
        for j in range(M):
            mssim, ssim_map = structural_similarity(
                cell,
                tiles[j],
                full=True,
                channel_axis=2,
                data_range=255,
                win_size=win_size,
            )
            if w_pixel is None or w_sum_i < 1e-8:
                cost[i, j] = 1.0 - float(mssim)
            else:
                # ssim_map shape (h, w, C); collapse channels then weight per pixel.
                ssim_2d = ssim_map.mean(axis=-1)
                weighted = float((ssim_2d * w_pixel).sum() / w_sum_i)
                cost[i, j] = 1.0 - weighted
    return cost


# ---------------------------------------------------------------------------
# Public cost-matrix entry point
# ---------------------------------------------------------------------------


def build_cost_matrix(
    cells: np.ndarray,
    tiles: np.ndarray,
    metric: Metric,
    saliency_per_cell: np.ndarray | None = None,
) -> np.ndarray:
    """Build a `(numCells, numTiles)` float32 cost matrix for the chosen metric.

    Args:
        cells: (N, h, w, 3) uint8 array of reference grid cells.
        tiles: (M, h, w, 3) uint8 array of tile pool images.
        metric: MSE or SSIM.
        saliency_per_cell: optional (N, h, w) float32 saliency map per cell. When
            provided, the cost is computed with per-pixel weighting.

    Returns:
        cost: (N, M) float32 cost matrix. Lower is better.
    """
    if cells.ndim != 4 or tiles.ndim != 4:
        raise ValueError("cells and tiles must be 4D arrays")
    if cells.shape[1:] != tiles.shape[1:]:
        raise ValueError(
            f"cell/tile shapes must match, got {cells.shape[1:]} vs {tiles.shape[1:]}"
        )
    if tiles.shape[0] == 0:
        raise ValueError("tile pool is empty")
    if cells.shape[0] == 0:
        return np.empty((0, tiles.shape[0]), dtype=np.float32)

    if metric == Metric.MSE:
        if saliency_per_cell is None:
            return _mse_cost_uniform(cells, tiles)
        return _mse_cost_weighted(cells, tiles, _saliency_weights(saliency_per_cell))

    if metric == Metric.SSIM:
        weights = (
            None if saliency_per_cell is None else _saliency_weights(saliency_per_cell)
        )
        return _ssim_cost(cells, tiles, weights)

    raise ValueError(f"unknown metric: {metric!r}")


# ---------------------------------------------------------------------------
# Tile assignment (reuse policies)
# ---------------------------------------------------------------------------


@dataclass
class AssignmentResult:
    """Result of `assign_tiles`: per-cell tile index plus diagnostic messages."""

    assignment: np.ndarray  # (numCells,) int64 tile indices.
    warnings: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)


def _greedy_with_capacity(
    cost: np.ndarray,
    max_repeats: int,
    priority: np.ndarray | None = None,
) -> np.ndarray:
    """Greedy capacity-constrained assignment. Cells processed in priority order (descending)."""
    N, M = cost.shape
    used = np.zeros(M, dtype=np.int32)
    assignment = np.empty(N, dtype=np.int64)
    order = np.arange(N) if priority is None else np.argsort(-priority, kind="stable")
    inf = np.float32(np.inf)
    for idx in order:
        row = cost[idx].astype(np.float32, copy=True)
        if max_repeats > 0:
            row[used >= max_repeats] = inf
        j = int(np.argmin(row))
        assignment[idx] = j
        used[j] += 1
    return assignment


def _hungarian_limited(
    cost: np.ndarray,
    k: int,
    max_cells_for_hungarian: int,
    priority: np.ndarray | None,
) -> tuple[np.ndarray, str | None]:
    """Run Hungarian with each tile column duplicated `k` times. Falls back to greedy if too big.

    Requires M*k >= N. Caller is responsible for the partial-fill case.
    """
    N, M = cost.shape
    expanded_cols = M * k
    if N * expanded_cols > max_cells_for_hungarian:
        return (
            _greedy_with_capacity(cost, max_repeats=k, priority=priority),
            f"Cost matrix {N}x{expanded_cols} too large for Hungarian; using greedy fallback.",
        )
    expanded = np.tile(cost, (1, k))
    row_ind, col_ind = linear_sum_assignment(expanded)
    assignment = np.empty(N, dtype=np.int64)
    assignment[row_ind] = col_ind % M
    return assignment, None


def _pick_cells_to_fill(
    N: int,
    fillable: int,
    priority: np.ndarray | None,
    rng_seed: int,
) -> tuple[np.ndarray, str]:
    """Pick which `fillable` cells to fill when there's not enough tile capacity for all N.

    Top-N salient cells when `priority` is provided, else `fillable` random cells.
    Returns the chosen cell indices sorted ascending plus a human-readable method label.
    """
    if priority is not None:
        chosen = np.argsort(-priority, kind="stable")[:fillable]
        method = "saliency priority"
    else:
        rng = np.random.default_rng(rng_seed)
        chosen = rng.choice(N, size=fillable, replace=False)
        method = "random selection"
    return np.sort(chosen), method


def _partial_fill_hungarian(
    cost: np.ndarray,
    chosen: np.ndarray,
    k: int,
    max_cells_for_hungarian: int,
) -> tuple[np.ndarray, str | None]:
    """Hungarian (or greedy fallback) on a chosen subset of cells with capacity k per tile.

    Returns a full-length (N,) assignment vector with -1 in cells not in `chosen`.
    """
    N, M = cost.shape
    fillable = chosen.shape[0]
    sub_cost = cost[chosen]
    full_assignment = np.full(N, -1, dtype=np.int64)
    expanded_cols = M * k
    if fillable * expanded_cols > max_cells_for_hungarian:
        warn = (
            f"Partial-fill cost {fillable}x{expanded_cols} too large for Hungarian; "
            "using greedy fallback."
        )
        sub_assignment = _greedy_with_capacity(sub_cost, max_repeats=k, priority=None)
        full_assignment[chosen] = sub_assignment
        return full_assignment, warn
    expanded = np.tile(sub_cost, (1, k)) if k > 1 else sub_cost
    row_ind, col_ind = linear_sum_assignment(expanded)
    full_assignment[chosen[row_ind]] = col_ind % M if k > 1 else col_ind
    return full_assignment, None


def assign_tiles(
    cost: np.ndarray,
    reuse: ReusePolicy,
    max_repeats: int = 1,
    priority: np.ndarray | None = None,
    max_cells_for_hungarian: int = 30_000_000,
    rng_seed: int = 0,
) -> AssignmentResult:
    """Assign each cell to a tile per the reuse policy.

    Args:
        cost: (N, M) float32 cost matrix from `build_cost_matrix`.
        reuse: how often any single tile may be reused.
        max_repeats: max uses per tile when reuse=LIMITED. Ignored otherwise.
        priority: optional (N,) priority array (higher = served first) used by the
            greedy fallback so that high-saliency cells claim tiles first, and
            (for UNIQUE with M < N) to choose which cells to fill at all.
        max_cells_for_hungarian: guardrail; if the (possibly expanded) cost matrix
            has more entries than this, fall back to greedy.
        rng_seed: seed for the random cell-selection used when reuse=UNIQUE,
            saliency is off, and tiles < cells. Fixed by default so the random
            subset is stable across re-renders.

    Returns:
        AssignmentResult with `assignment` (N,) int64 tile indices and any warnings.
        Entries of `assignment` equal to -1 mean "no tile assigned" (only happens
        for UNIQUE with M < N); the composer must fill those positions from a
        fallback source.
    """
    N, M = cost.shape
    result = AssignmentResult(assignment=np.empty(N, dtype=np.int64))

    if reuse == ReusePolicy.UNLIMITED:
        result.assignment = cost.argmin(axis=1).astype(np.int64)
        return result

    if reuse in (ReusePolicy.UNIQUE, ReusePolicy.LIMITED):
        k = 1 if reuse == ReusePolicy.UNIQUE else int(max_repeats)
        if k < 1:
            raise ValueError(f"max_repeats must be >= 1, got {max_repeats}")
        fillable = min(N, M * k)

        if fillable == N:
            # Enough capacity to fill every cell.
            if k == 1:
                if N * M > max_cells_for_hungarian:
                    result.warnings.append(
                        f"Cost matrix {N}x{M} too large for Hungarian; using greedy fallback."
                    )
                    result.assignment = _greedy_with_capacity(
                        cost, max_repeats=1, priority=priority
                    )
                    return result
                row_ind, col_ind = linear_sum_assignment(cost)
                result.assignment[row_ind] = col_ind
                return result
            assignment, warn = _hungarian_limited(
                cost, k, max_cells_for_hungarian, priority
            )
            result.assignment = assignment
            if warn:
                result.warnings.append(warn)
            return result

        # Not enough capacity: fill only `fillable` cells, leave the rest blank
        # (assignment == -1, composer fills with white).
        chosen, method = _pick_cells_to_fill(N, fillable, priority, rng_seed)
        full_assignment, warn = _partial_fill_hungarian(
            cost, chosen, k, max_cells_for_hungarian
        )
        result.assignment = full_assignment
        if reuse == ReusePolicy.UNIQUE:
            cap_desc = f"only {M} unique tiles available"
        else:
            cap_desc = f"max_repeats={k} x {M} tiles = {fillable} slots"
        result.warnings.append(
            f"{cap_desc} for {N} cells; filling {fillable} cells by {method}, "
            f"remaining {N - fillable} cells shown as white."
        )
        if warn:
            result.warnings.append(warn)
        return result

    raise ValueError(f"unknown reuse policy: {reuse!r}")
