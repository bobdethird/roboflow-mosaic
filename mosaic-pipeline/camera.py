"""Shared camera geometry for the mosaic zoom path."""

from __future__ import annotations

import math


def clamp(value: float, low: float, high: float) -> float:
    return max(low, min(high, value))


def zoom_start_window(
    rect: tuple[float, float, float, float],
    world_w: float,
    world_h: float,
) -> tuple[float, float, float, float]:
    """Opening-cell rect expanded to the output aspect, clamped to the world."""
    rect_x, rect_y, rect_w, rect_h = rect
    aspect = world_w / world_h
    w = min(world_w, max(rect_w, rect_h * aspect))
    h = w / aspect
    x = clamp(rect_x + rect_w / 2 - w / 2, 0.0, world_w - w)
    y = clamp(rect_y + rect_h / 2 - h / 2, 0.0, world_h - h)
    return (x, y, w, h)


def window_at_progress(
    t: float,
    start: tuple[float, float, float, float],
    world_w: float,
    world_h: float,
) -> tuple[float, float, float, float]:
    """World-space zoom window at normalized progress from opening cell to full world."""
    if t <= 0.0:
        return start
    if t >= 1.0:
        return (0.0, 0.0, world_w, world_h)
    start_x, start_y, start_w, start_h = start
    w = start_w * math.pow(world_w / start_w, t)
    h = start_h * math.pow(world_h / start_h, t)
    size_t = clamp((w - start_w) / max(0.001, world_w - start_w), 0.0, 1.0)
    x = start_x + (0.0 - start_x) * size_t
    y = start_y + (0.0 - start_y) * size_t
    return (x, y, w, h)
