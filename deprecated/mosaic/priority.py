"""Priority maps used to weight the per-pixel MSE cost.

Priority maps generalize the saliency idea: any (H, W) float32 array in [0, 1]
that the matching code can use as a per-pixel weight when building the cost
matrix. We expose four sources via the `PrioritySource` enum:

- `OFF`: no weighting (uniform).
- `SALIENCY`: OpenCV's classical `StaticSaliencyFineGrained`.
- `FACE_FEATURES`: detect the face, then place bright Gaussian-like blobs on
  the eyes, nose, and mouth; the rest of the face gets a medium baseline.
- `FACE_WHOLE`: detect the face, then mark the face region uniformly.

The face detector uses OpenCV's bundled Haar cascade
(`haarcascade_frontalface_default.xml`) so there are no external model files.
For non-frontal or non-portrait images, the face-based maps fall back to a
uniform map (priority = 1) and `detect_face` returns `None`.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

import cv2  # type: ignore[import-untyped]
import numpy as np

from mosaic.saliency import compute_saliency


class PrioritySource(str, Enum):
    """Where the matching cost's per-pixel weights come from."""

    OFF = "Off"
    SALIENCY = "Saliency (OpenCV)"
    FACE_FEATURES = "Face features"
    FACE_WHOLE = "Whole face"


@dataclass(frozen=True)
class FaceBBox:
    x: int
    y: int
    w: int
    h: int

    @property
    def cx(self) -> float:
        return self.x + self.w / 2.0

    @property
    def cy(self) -> float:
        return self.y + self.h / 2.0


_FACE_CASCADE: cv2.CascadeClassifier | None = None


def _face_cascade() -> cv2.CascadeClassifier:
    global _FACE_CASCADE
    if _FACE_CASCADE is None:
        path = cv2.data.haarcascades + "haarcascade_frontalface_default.xml"
        _FACE_CASCADE = cv2.CascadeClassifier(path)
    return _FACE_CASCADE


def detect_face(img_rgb: np.ndarray) -> FaceBBox | None:
    """Detect the largest frontal face in the image. Returns None if no face is found."""
    if img_rgb.ndim != 3 or img_rgb.shape[2] != 3:
        raise ValueError(f"expected (H, W, 3) RGB array, got shape {img_rgb.shape}")
    cascade = _face_cascade()
    if cascade.empty():
        return None
    gray = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2GRAY)
    h, w = gray.shape
    min_side = max(30, int(min(h, w) * 0.08))
    faces = cascade.detectMultiScale(
        gray,
        scaleFactor=1.1,
        minNeighbors=5,
        minSize=(min_side, min_side),
    )
    if len(faces) == 0:
        return None
    # Largest detected face wins (presumed subject).
    x, y, fw, fh = max(faces, key=lambda b: int(b[2]) * int(b[3]))
    return FaceBBox(x=int(x), y=int(y), w=int(fw), h=int(fh))


def _feature_blob_map(
    h: int,
    w: int,
    face: FaceBBox,
    feature_specs: list[tuple[float, float, float, float]],
    peak: float = 1.0,
    falloff: float = 2.0,
) -> np.ndarray:
    """Sum of Gaussian-like blobs, one per feature, normalized so the peak is `peak`."""
    yy, xx = np.indices((h, w))
    out = np.zeros((h, w), dtype=np.float32)
    for rcx, rcy, rrx, rry in feature_specs:
        cx = face.x + rcx * face.w
        cy = face.y + rcy * face.h
        rx = max(rrx * face.w, 1.0)
        ry = max(rry * face.h, 1.0)
        d = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2
        # exp(-falloff * d) is ~1 at center, ~0 at 2 sigma.
        out = np.maximum(out, peak * np.exp(-falloff * d).astype(np.float32))
    return out


def _ellipse_mask(h: int, w: int, face: FaceBBox, y_scale: float = 1.05) -> np.ndarray:
    """Soft 1.0-inside / 0-outside ellipse aligned to the face bbox."""
    yy, xx = np.indices((h, w))
    rx = max(face.w / 2.0, 1.0)
    ry = max(face.h / 2.0 * y_scale, 1.0)
    d = ((xx - face.cx) / rx) ** 2 + ((yy - face.cy) / ry) ** 2
    return (d <= 1.0).astype(np.float32)


def compute_face_features_priority(
    img_rgb: np.ndarray,
    face: FaceBBox | None = None,
    *,
    smooth: bool = True,
) -> np.ndarray:
    """Priority map that emphasizes eyes / nose / mouth, then the rest of the face.

    Layout (priority values):
        - eyes / nose / mouth blobs: peak ~1.0
        - rest of the face ellipse: 0.4
        - everything outside the face: 0.0

    If no face is detected, returns a uniform 1.0 map so the matching still runs.
    """
    h, w = img_rgb.shape[:2]
    if face is None:
        face = detect_face(img_rgb)
    if face is None:
        return np.ones((h, w), dtype=np.float32)

    # Baseline = face ellipse at medium priority.
    base = _ellipse_mask(h, w, face) * 0.4

    # Feature blobs (relative positions inside the face bbox).
    feature_specs: list[tuple[float, float, float, float]] = [
        (0.30, 0.40, 0.13, 0.08),  # left eye  (image-left side of face)
        (0.70, 0.40, 0.13, 0.08),  # right eye
        (0.50, 0.58, 0.10, 0.10),  # nose
        (0.50, 0.78, 0.20, 0.08),  # mouth
    ]
    blobs = _feature_blob_map(h, w, face, feature_specs, peak=1.0, falloff=2.0)

    priority = np.maximum(base, blobs)

    if smooth:
        sigma = max(2.0, min(face.w, face.h) * 0.015)
        priority = cv2.GaussianBlur(priority, (0, 0), sigmaX=sigma).astype(np.float32)
    return priority.clip(0.0, 1.0)


def compute_face_whole_priority(
    img_rgb: np.ndarray,
    face: FaceBBox | None = None,
    *,
    smooth: bool = True,
) -> np.ndarray:
    """Priority map that emphasizes the whole face uniformly.

    Inside the face ellipse: 1.0. Outside: 0.0. Slight Gaussian blur on the edge
    so the boundary isn't a hard step.
    """
    h, w = img_rgb.shape[:2]
    if face is None:
        face = detect_face(img_rgb)
    if face is None:
        return np.ones((h, w), dtype=np.float32)
    priority = _ellipse_mask(h, w, face)
    if smooth:
        sigma = max(2.0, min(face.w, face.h) * 0.04)
        priority = cv2.GaussianBlur(priority, (0, 0), sigmaX=sigma).astype(np.float32)
    return priority.clip(0.0, 1.0)


def compute_priority(img_rgb: np.ndarray, source: PrioritySource) -> np.ndarray | None:
    """Dispatch to the right priority map computation for `source`.

    Returns:
        (H, W) float32 priority map in [0, 1], or None for `PrioritySource.OFF`.
    """
    if source == PrioritySource.OFF:
        return None
    if source == PrioritySource.SALIENCY:
        return compute_saliency(img_rgb)
    if source == PrioritySource.FACE_FEATURES:
        return compute_face_features_priority(img_rgb)
    if source == PrioritySource.FACE_WHOLE:
        return compute_face_whole_priority(img_rgb)
    raise ValueError(f"unknown priority source: {source!r}")


# Same relative geometry as `compute_face_features_priority` so the overlay
# matches exactly what the priority map uses.
_FEATURE_LAYOUT: list[tuple[str, tuple[float, float, float, float], tuple[int, int, int]]] = [
    ("L eye", (0.30, 0.40, 0.13, 0.08), (60, 230, 60)),
    ("R eye", (0.70, 0.40, 0.13, 0.08), (60, 230, 60)),
    ("Nose", (0.50, 0.58, 0.10, 0.10), (60, 160, 240)),
    ("Mouth", (0.50, 0.78, 0.20, 0.08), (240, 80, 160)),
]
_FACE_COLOR: tuple[int, int, int] = (255, 220, 40)  # warm yellow for the face bbox


def draw_face_overlay(
    img_rgb: np.ndarray, face: FaceBBox | None = None
) -> np.ndarray:
    """Return a copy of `img_rgb` with the detected face / feature regions drawn on top.

    The regions match those used by `compute_face_features_priority` (face bbox
    plus heuristic ellipses for L/R eye, nose, mouth) so this overlay is a
    faithful preview of where the priority weights are placed. If no face is
    detected, returns the original image unchanged.
    """
    if img_rgb.ndim != 3 or img_rgb.shape[2] != 3:
        raise ValueError(f"expected (H, W, 3) RGB array, got shape {img_rgb.shape}")
    out = np.ascontiguousarray(img_rgb).copy()
    if face is None:
        face = detect_face(img_rgb)
    if face is None:
        return out

    h, w = out.shape[:2]
    line_thickness = max(2, int(min(h, w) * 0.004))
    font = cv2.FONT_HERSHEY_SIMPLEX
    font_scale = max(0.5, min(h, w) * 0.0015)
    font_thickness = max(1, int(min(h, w) * 0.0025))

    # Face bbox + label.
    cv2.rectangle(
        out,
        (face.x, face.y),
        (face.x + face.w, face.y + face.h),
        _FACE_COLOR,
        line_thickness,
    )
    label_pos = (face.x, max(face.y - 8, int(font_scale * 24)))
    cv2.putText(
        out,
        "Face",
        label_pos,
        font,
        font_scale,
        _FACE_COLOR,
        font_thickness,
        cv2.LINE_AA,
    )

    # Feature ellipses + labels.
    for label, (rcx, rcy, rrx, rry), color in _FEATURE_LAYOUT:
        cx = int(face.x + rcx * face.w)
        cy = int(face.y + rcy * face.h)
        rx = max(int(rrx * face.w), 2)
        ry = max(int(rry * face.h), 2)
        cv2.ellipse(out, (cx, cy), (rx, ry), 0, 0, 360, color, line_thickness)
        text_pos = (
            max(cx - rx, 4),
            max(cy - ry - 6, int(font_scale * 18)),
        )
        cv2.putText(
            out,
            label,
            text_pos,
            font,
            font_scale * 0.85,
            color,
            font_thickness,
            cv2.LINE_AA,
        )

    return out
