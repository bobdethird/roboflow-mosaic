"""Streamlit photo mosaic app.

Upload a pool of tile photos plus a reference photo, then choose:
- distance metric: MSE or SSIM
- priority map: Off / OpenCV saliency / Face features / Whole face
- tile reuse policy

Use one of three buttons:
- Generate mosaic: single variant with the current settings.
- Compare metric x priority: 2x2 of (MSE/SSIM) x (Off / selected priority).
- Compare priority maps: 1x4 of the selected metric x all four priority sources.
"""

from __future__ import annotations

import time
from io import BytesIO

import numpy as np
import streamlit as st
from PIL import Image

from mosaic.compose import compose_mosaic, quality_scores
from mosaic.matching import Metric, ReusePolicy, assign_tiles, build_cost_matrix
from mosaic.priority import (
    PrioritySource,
    compute_priority,
    detect_face,
    draw_face_overlay,
)
from mosaic.saliency import per_cell_mean, resample_saliency
from mosaic.tiles import filenames_summary, load_tiles, prepare_reference

st.set_page_config(
    page_title="Photo Mosaic",
    page_icon=None,
    layout="wide",
)


# ---------------------------------------------------------------------------
# Cached pipeline pieces. Keyed on raw upload bytes plus grid params so that
# toggling metric / priority only re-runs the cheap downstream parts.
# ---------------------------------------------------------------------------


@st.cache_data(show_spinner=False, max_entries=4)
def _cached_tiles(tile_blobs: tuple[bytes, ...], tile_h: int, tile_w: int):
    sources = [BytesIO(b) for b in tile_blobs]
    return load_tiles(sources, tile_h, tile_w)


@st.cache_data(show_spinner=False, max_entries=4)
def _cached_reference(ref_bytes: bytes, cells_per_row: int, tile_h: int, tile_w: int):
    return prepare_reference(BytesIO(ref_bytes), cells_per_row, tile_h, tile_w)


@st.cache_data(show_spinner=False, max_entries=4)
def _cached_face_bbox(ref_bytes: bytes):
    img = np.asarray(Image.open(BytesIO(ref_bytes)).convert("RGB"), dtype=np.uint8)
    return detect_face(img)


@st.cache_data(show_spinner=False, max_entries=4)
def _cached_face_overlay(ref_bytes: bytes) -> np.ndarray:
    img = np.asarray(Image.open(BytesIO(ref_bytes)).convert("RGB"), dtype=np.uint8)
    return draw_face_overlay(img)


@st.cache_data(show_spinner=False, max_entries=16)
def _cached_full_priority(ref_bytes: bytes, source_str: str) -> np.ndarray | None:
    source = PrioritySource(source_str)
    if source == PrioritySource.OFF:
        return None
    img = np.asarray(Image.open(BytesIO(ref_bytes)).convert("RGB"), dtype=np.uint8)
    return compute_priority(img, source)


@st.cache_data(show_spinner=False, max_entries=16)
def _cached_per_cell_priority(
    ref_bytes: bytes, source_str: str, cells_per_row: int, tile_h: int, tile_w: int
) -> np.ndarray | None:
    pri = _cached_full_priority(ref_bytes, source_str)
    if pri is None:
        return None
    grid = _cached_reference(ref_bytes, cells_per_row, tile_h, tile_w)
    return resample_saliency(pri, grid.grid_rows, grid.grid_cols, tile_h, tile_w)


@st.cache_data(show_spinner=False, max_entries=32)
def _cached_cost(
    ref_bytes: bytes,
    tile_blobs: tuple[bytes, ...],
    cells_per_row: int,
    tile_h: int,
    tile_w: int,
    metric_str: str,
    priority_source_str: str,
) -> np.ndarray:
    grid = _cached_reference(ref_bytes, cells_per_row, tile_h, tile_w)
    tiles, _ = _cached_tiles(tile_blobs, tile_h, tile_w)
    per_cell_pri = _cached_per_cell_priority(
        ref_bytes, priority_source_str, cells_per_row, tile_h, tile_w
    )
    return build_cost_matrix(grid.cells, tiles, Metric(metric_str), per_cell_pri)


# ---------------------------------------------------------------------------
# Variant runner (single combination of metric + priority source)
# ---------------------------------------------------------------------------


def _run_variant(
    ref_bytes: bytes,
    tile_blobs: tuple[bytes, ...],
    cells_per_row: int,
    tile_h: int,
    tile_w: int,
    metric: Metric,
    priority_source: PrioritySource,
    reuse: ReusePolicy,
    max_repeats: int,
) -> dict:
    """Run one (metric, priority source) variant end-to-end."""
    t0 = time.perf_counter()
    grid = _cached_reference(ref_bytes, cells_per_row, tile_h, tile_w)
    tiles, names = _cached_tiles(tile_blobs, tile_h, tile_w)
    cost = _cached_cost(
        ref_bytes,
        tile_blobs,
        cells_per_row,
        tile_h,
        tile_w,
        metric.value,
        priority_source.value,
    )
    priority = None
    if priority_source != PrioritySource.OFF:
        per_cell_pri = _cached_per_cell_priority(
            ref_bytes, priority_source.value, cells_per_row, tile_h, tile_w
        )
        if per_cell_pri is not None:
            priority = per_cell_mean(per_cell_pri)

    result = assign_tiles(
        cost,
        reuse=reuse,
        max_repeats=max_repeats,
        priority=priority,
    )
    mosaic = compose_mosaic(
        tiles,
        result.assignment,
        grid.grid_rows,
        grid.grid_cols,
    )
    scores = quality_scores(mosaic, grid.canvas)
    total_cells = grid.grid_rows * grid.grid_cols
    filled_mask = result.assignment >= 0
    filled_cells = int(filled_mask.sum())
    unique_tiles_used = int(np.unique(result.assignment[filled_mask]).size)
    return {
        "metric": metric,
        "priority_source": priority_source,
        "mosaic": mosaic,
        "scores": scores,
        "warnings": result.warnings,
        "elapsed": time.perf_counter() - t0,
        "tile_names": names,
        "grid_rows": grid.grid_rows,
        "grid_cols": grid.grid_cols,
        "total_cells": total_cells,
        "filled_cells": filled_cells,
        "unique_tiles_used": unique_tiles_used,
        "num_tiles": tiles.shape[0],
    }


def _variant_label(metric: Metric, priority_source: PrioritySource) -> str:
    if priority_source == PrioritySource.OFF:
        return metric.value
    return f"{metric.value} + {priority_source.value}"


def _variant_caption(variant: dict) -> str:
    label = _variant_label(variant["metric"], variant["priority_source"])
    fill = (
        f"{variant['filled_cells']}/{variant['total_cells']} cells"
        if variant["filled_cells"] != variant["total_cells"]
        else f"{variant['total_cells']} cells"
    )
    return (
        f"**{label}**\n\n"
        f"{variant['scores'].as_caption()}\n\n"
        f"{fill} · {variant['unique_tiles_used']}/{variant['num_tiles']} tiles · "
        f"{variant['elapsed']:.2f}s"
    )


def _priority_preview_image(ref_bytes: bytes, source: PrioritySource) -> np.ndarray | None:
    pri = _cached_full_priority(ref_bytes, source.value)
    if pri is None:
        return None
    return (pri * 255).clip(0, 255).astype(np.uint8)


def _render_variant_tile(variant: dict, container) -> None:
    container.image(variant["mosaic"], width="stretch")
    container.caption(_variant_caption(variant))
    for w in variant["warnings"]:
        container.warning(w)


def _render_preview_strip(
    ref_bytes: bytes,
    grid,
    priority_source: PrioritySource,
    face,
) -> None:
    """Render up to 3 small preview panels: Reference, detected regions, priority map."""
    panels: list[tuple[str, np.ndarray, bool]] = [
        ("Reference (resized to mosaic canvas)", grid.canvas, False),
    ]
    if face is not None:
        panels.append(
            ("Detected regions (face / eyes / nose / mouth)", _cached_face_overlay(ref_bytes), False)
        )
    if priority_source != PrioritySource.OFF:
        prev = _priority_preview_image(ref_bytes, priority_source)
        if prev is not None:
            panels.append((f"Priority map: {priority_source.value}", prev, True))

    n = len(panels)
    # Keep each preview small (~25% width) by padding to 4 columns total.
    weights = [1] * n + ([4 - n] if n < 4 else [])
    cols = st.columns(weights)
    for i, (caption, image, clamp) in enumerate(panels):
        cols[i].image(image, width="stretch", clamp=clamp)
        cols[i].caption(caption)


# ---------------------------------------------------------------------------
# Sidebar controls
# ---------------------------------------------------------------------------


with st.sidebar:
    st.header("Inputs")
    tile_uploads = st.file_uploader(
        "Tile photos (the building blocks)",
        accept_multiple_files=True,
        type=["jpg", "jpeg", "png", "webp", "bmp"],
        help="Upload many photos. Each will be center-cropped to the tile aspect ratio.",
    )
    ref_upload = st.file_uploader(
        "Reference photo (the target)",
        type=["jpg", "jpeg", "png", "webp", "bmp"],
        help="The mosaic will try to look like this image.",
    )

    st.header("Grid")
    cells_per_row = st.slider(
        "Cells per row", min_value=20, max_value=150, value=60, step=5
    )
    tile_px = st.slider(
        "Tile pixel size (square)",
        min_value=8,
        max_value=64,
        value=32,
        step=4,
        help="Each tile is resized to this many pixels per side. Larger = sharper tiles, slower SSIM.",
    )

    st.header("Matching")
    metric_str = st.radio(
        "Distance metric",
        options=[m.value for m in Metric],
        index=0,
        horizontal=True,
        help="MSE is pixelwise mean-squared error. SSIM is structural similarity (slower but more perceptual).",
    )
    priority_source_str = st.radio(
        "Priority map (per-pixel weights for the cost)",
        options=[s.value for s in PrioritySource],
        index=0,
        help=(
            "Off: uniform pixel weights. "
            "Saliency: OpenCV's classical static saliency. "
            "Face features: high weight on eyes/nose/mouth, medium on the rest of the face. "
            "Whole face: uniform high weight on the whole face."
        ),
    )

    st.header("Tile reuse")
    reuse_str = st.radio(
        "Policy",
        options=[r.value for r in ReusePolicy],
        index=0,
        horizontal=True,
        help=(
            "Unlimited: any tile can fill many cells (best visual match). "
            "Limited: cap how many times a tile can appear; if max_repeats x tiles "
            "is less than the cell count, only the most important cells are filled "
            "and the rest are left blank (white). "
            "Unique: each tile at most once; if tiles < cells, only the most "
            "important cells are filled and the rest are left blank (white)."
        ),
    )
    max_repeats = 1
    if reuse_str == ReusePolicy.LIMITED.value:
        max_repeats = st.slider("Max repeats per tile", min_value=1, max_value=50, value=5)

    st.header("Run")
    generate = st.button("Generate mosaic", type="primary", width="stretch")
    compare_priorities = st.button("Compare priority maps", width="stretch")
    compare_metrics = st.button("Compare metric x priority", width="stretch")

# ---------------------------------------------------------------------------
# Main panel
# ---------------------------------------------------------------------------


st.title("Photo Mosaic")
st.write(
    "Upload tile photos plus a target image, then compare matching strategies. "
    "Priority maps weight per-pixel MSE so important regions (e.g. eyes / nose / mouth) "
    "get more faithful tile matches."
)


def _ensure_inputs() -> tuple[bytes, tuple[bytes, ...]] | None:
    if not tile_uploads:
        st.info("Upload at least one tile photo to begin.")
        return None
    if ref_upload is None:
        st.info("Upload a reference photo to begin.")
        return None
    ref_bytes = ref_upload.getvalue()
    tile_blobs = tuple(f.getvalue() for f in tile_uploads)
    return ref_bytes, tile_blobs


inputs = _ensure_inputs()
if inputs is None:
    st.stop()

ref_bytes, tile_blobs = inputs

with st.spinner("Preparing tiles and reference..."):
    tiles_array, names = _cached_tiles(tile_blobs, tile_px, tile_px)
    grid = _cached_reference(ref_bytes, cells_per_row, tile_px, tile_px)

if tiles_array.shape[0] == 0:
    st.error("None of the uploaded files could be decoded as images.")
    st.stop()

face = _cached_face_bbox(ref_bytes)
face_note = (
    f"face detected at x={face.x}, y={face.y}, w={face.w}, h={face.h}"
    if face is not None
    else "no face detected (face-based priority maps will fall back to uniform)"
)

total_cells = grid.grid_rows * grid.grid_cols
st.caption(
    f"Loaded {tiles_array.shape[0]} tile photos · "
    f"grid {grid.grid_cols} x {grid.grid_rows} = {total_cells} cells · "
    f"{face_note} · tiles preview: {filenames_summary(names)}"
)

reuse = ReusePolicy(reuse_str)
metric = Metric(metric_str)
priority_source = PrioritySource(priority_source_str)


if compare_priorities:
    st.subheader(f"Compare priority maps  ·  metric = {metric.value}")
    # Shared reference + face-overlay preview on top so every variant column
    # below shows only what changes (priority map + mosaic).
    _render_preview_strip(ref_bytes, grid, PrioritySource.OFF, face)

    sources = list(PrioritySource)
    variants = []
    progress = st.progress(0.0, text="Running variants...")
    for idx, src in enumerate(sources):
        progress.progress(
            idx / len(sources),
            text=f"Running {_variant_label(metric, src)}...",
        )
        variants.append(
            _run_variant(
                ref_bytes,
                tile_blobs,
                cells_per_row,
                tile_px,
                tile_px,
                metric,
                src,
                reuse,
                max_repeats,
            )
        )
    progress.progress(1.0, text="Done")
    progress.empty()

    cols = st.columns(4)
    for variant, col in zip(variants, cols):
        src = variant["priority_source"]
        preview = _priority_preview_image(ref_bytes, src)
        if preview is None:
            col.image(grid.canvas, width="stretch")
            col.caption(f"Priority: {src.value} (uniform)")
        else:
            col.image(preview, width="stretch", clamp=True)
            col.caption(f"Priority: {src.value}")
        _render_variant_tile(variant, col)

    best = max(variants, key=lambda v: v["scores"].ssim)
    st.success(
        f"Best by SSIM: **{_variant_label(best['metric'], best['priority_source'])}** "
        f"({best['scores'].as_caption()})"
    )
elif compare_metrics:
    st.subheader("Compare metric x priority")
    combos = [
        (Metric.MSE, PrioritySource.OFF),
        (Metric.MSE, priority_source if priority_source != PrioritySource.OFF else PrioritySource.SALIENCY),
        (Metric.SSIM, PrioritySource.OFF),
        (Metric.SSIM, priority_source if priority_source != PrioritySource.OFF else PrioritySource.SALIENCY),
    ]
    variants = []
    progress = st.progress(0.0, text="Running variants...")
    for idx, (m, src) in enumerate(combos):
        progress.progress(
            idx / len(combos), text=f"Running {_variant_label(m, src)}..."
        )
        variants.append(
            _run_variant(
                ref_bytes,
                tile_blobs,
                cells_per_row,
                tile_px,
                tile_px,
                m,
                src,
                reuse,
                max_repeats,
            )
        )
    progress.progress(1.0, text="Done")
    progress.empty()

    _render_preview_strip(ref_bytes, grid, combos[1][1], face)

    variant_cols = st.columns(4)
    for variant, col in zip(variants, variant_cols):
        _render_variant_tile(variant, col)

    best = max(variants, key=lambda v: v["scores"].ssim)
    st.success(
        f"Best by SSIM: **{_variant_label(best['metric'], best['priority_source'])}** "
        f"({best['scores'].as_caption()})"
    )
elif generate:
    st.subheader(f"Mosaic ({_variant_label(metric, priority_source)})")
    with st.spinner("Building cost matrix and assembling mosaic..."):
        variant = _run_variant(
            ref_bytes,
            tile_blobs,
            cells_per_row,
            tile_px,
            tile_px,
            metric,
            priority_source,
            reuse,
            max_repeats,
        )

    _render_preview_strip(ref_bytes, grid, priority_source, face)

    # Mosaic shown beneath the preview strip so it has room to breathe.
    mosaic_cols = st.columns([3, 1])
    _render_variant_tile(variant, mosaic_cols[0])
else:
    _render_preview_strip(ref_bytes, grid, priority_source, face)
    st.info(
        "Press **Generate mosaic** for the current settings, **Compare priority maps** "
        "to see all 4 priority sources side by side, or **Compare metric x priority** "
        "to pit MSE against SSIM with the same priority."
    )
