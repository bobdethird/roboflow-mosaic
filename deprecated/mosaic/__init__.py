"""Photo mosaic builder with togglable MSE/SSIM metrics and selectable priority maps."""

from mosaic.compose import compose_mosaic, quality_scores
from mosaic.matching import Metric, ReusePolicy, assign_tiles, build_cost_matrix
from mosaic.priority import (
    FaceBBox,
    PrioritySource,
    compute_face_features_priority,
    compute_face_whole_priority,
    compute_priority,
    detect_face,
    draw_face_overlay,
)
from mosaic.saliency import compute_saliency, per_cell_mean, resample_saliency
from mosaic.tiles import load_tiles, prepare_reference

__all__ = [
    "load_tiles",
    "prepare_reference",
    "compute_saliency",
    "resample_saliency",
    "per_cell_mean",
    "PrioritySource",
    "FaceBBox",
    "compute_face_features_priority",
    "compute_face_whole_priority",
    "compute_priority",
    "detect_face",
    "draw_face_overlay",
    "build_cost_matrix",
    "assign_tiles",
    "Metric",
    "ReusePolicy",
    "compose_mosaic",
    "quality_scores",
]
