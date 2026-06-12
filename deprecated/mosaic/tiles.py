"""Tile pool loading and reference-image grid preparation."""

from __future__ import annotations

from dataclasses import dataclass
from io import BytesIO
from typing import Iterable, Sequence

import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError


@dataclass(frozen=True)
class ReferenceGrid:
    """Reference image resized to the mosaic canvas and split into cells.

    Attributes:
        canvas: (H, W, 3) uint8 array sized exactly grid_rows*tile_h by grid_cols*tile_w.
        cells: (grid_rows*grid_cols, tile_h, tile_w, 3) uint8 cells, row-major order.
        grid_rows: number of cell rows.
        grid_cols: number of cell columns.
        tile_h: cell / tile height in pixels.
        tile_w: cell / tile width in pixels.
    """

    canvas: np.ndarray
    cells: np.ndarray
    grid_rows: int
    grid_cols: int
    tile_h: int
    tile_w: int


def _open_rgb(source) -> Image.Image:
    """Open an image source (path, bytes, file-like) as an RGB PIL image with EXIF orientation applied."""
    if isinstance(source, Image.Image):
        img = source
    elif isinstance(source, (bytes, bytearray)):
        img = Image.open(BytesIO(bytes(source)))
    elif hasattr(source, "read"):
        # Streamlit UploadedFile / generic file-like.
        try:
            source.seek(0)
        except (AttributeError, OSError):
            pass
        img = Image.open(source)
    else:
        img = Image.open(source)

    img = ImageOps.exif_transpose(img)
    if img.mode != "RGB":
        img = img.convert("RGB")
    return img


def _center_crop_resize(img: Image.Image, tile_h: int, tile_w: int) -> np.ndarray:
    """Center-crop to the target aspect ratio, then resize to (tile_h, tile_w)."""
    src_w, src_h = img.size
    target_ratio = tile_w / tile_h
    src_ratio = src_w / src_h

    if src_ratio > target_ratio:
        # Source is wider than target -> crop width.
        new_w = int(round(src_h * target_ratio))
        left = (src_w - new_w) // 2
        box = (left, 0, left + new_w, src_h)
    else:
        # Source is taller (or equal) -> crop height.
        new_h = int(round(src_w / target_ratio))
        top = (src_h - new_h) // 2
        box = (0, top, src_w, top + new_h)

    cropped = img.crop(box)
    resized = cropped.resize((tile_w, tile_h), Image.LANCZOS)
    return np.asarray(resized, dtype=np.uint8)


def load_tiles(
    sources: Iterable,
    tile_h: int,
    tile_w: int,
) -> tuple[np.ndarray, list[str]]:
    """Load tile photos into a stacked uint8 array.

    Each source is center-cropped to match the tile aspect ratio, then resized to
    (tile_h, tile_w). Files that fail to decode are skipped silently in the array
    but their filenames are still returned in the second list so the caller can warn.

    Args:
        sources: iterable of paths, bytes, or file-like objects (e.g. Streamlit uploads).
        tile_h: tile height in pixels.
        tile_w: tile width in pixels.

    Returns:
        tiles: (N, tile_h, tile_w, 3) uint8 array. N == number of successfully loaded tiles.
        filenames: list of human-readable filenames matching the successfully loaded tiles.
    """
    if tile_h <= 0 or tile_w <= 0:
        raise ValueError(f"tile dimensions must be positive, got ({tile_h}, {tile_w})")

    tiles: list[np.ndarray] = []
    names: list[str] = []
    for src in sources:
        # Best-effort filename extraction for debugging.
        name = getattr(src, "name", None) or (str(src) if isinstance(src, str) else "<bytes>")
        try:
            img = _open_rgb(src)
        except (UnidentifiedImageError, OSError):
            continue
        tile = _center_crop_resize(img, tile_h, tile_w)
        tiles.append(tile)
        names.append(name)

    if not tiles:
        return np.empty((0, tile_h, tile_w, 3), dtype=np.uint8), []

    return np.stack(tiles, axis=0), names


def prepare_reference(
    reference,
    cells_per_row: int,
    tile_h: int,
    tile_w: int,
) -> ReferenceGrid:
    """Resize the reference image to the mosaic canvas and split it into cells.

    The number of grid rows is derived from the reference's aspect ratio so that
    individual cells stay close to a 1:1 mapping with the reference's pixels.

    Args:
        reference: a path, bytes, file-like object, or PIL image.
        cells_per_row: number of mosaic cells along the width.
        tile_h: tile/cell height in pixels.
        tile_w: tile/cell width in pixels.

    Returns:
        ReferenceGrid containing the resized canvas and per-cell array.
    """
    if cells_per_row <= 0:
        raise ValueError(f"cells_per_row must be positive, got {cells_per_row}")

    img = _open_rgb(reference)
    src_w, src_h = img.size

    # Choose grid_rows so that the canvas aspect ratio matches the reference as
    # closely as possible. Each cell is tile_w x tile_h pixels on the canvas.
    grid_cols = int(cells_per_row)
    # Effective aspect of one cell on the canvas: (tile_w / tile_h).
    # We want (grid_cols * tile_w) / (grid_rows * tile_h) ~= src_w / src_h.
    grid_rows = max(1, int(round(grid_cols * (src_h / src_w) * (tile_w / tile_h))))

    canvas_w = grid_cols * tile_w
    canvas_h = grid_rows * tile_h
    resized = img.resize((canvas_w, canvas_h), Image.LANCZOS)
    canvas = np.asarray(resized, dtype=np.uint8)

    # Split into cells with a reshape+transpose trick: no Python loop required.
    # canvas shape: (grid_rows*tile_h, grid_cols*tile_w, 3)
    cells = (
        canvas.reshape(grid_rows, tile_h, grid_cols, tile_w, 3)
        .transpose(0, 2, 1, 3, 4)
        .reshape(grid_rows * grid_cols, tile_h, tile_w, 3)
        .copy()
    )

    return ReferenceGrid(
        canvas=canvas,
        cells=cells,
        grid_rows=grid_rows,
        grid_cols=grid_cols,
        tile_h=tile_h,
        tile_w=tile_w,
    )


def filenames_summary(names: Sequence[str], max_items: int = 5) -> str:
    """Tiny helper for status messages: 'a.jpg, b.jpg, ... (+12 more)'."""
    if not names:
        return "<none>"
    if len(names) <= max_items:
        return ", ".join(names)
    head = ", ".join(names[:max_items])
    return f"{head}, ... (+{len(names) - max_items} more)"
