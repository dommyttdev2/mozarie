"""Mask composition helpers used by preview and file save paths."""

from __future__ import annotations

import numpy as np


def compose_masks(
    shape: tuple[int, int],
    apply_masks: list[np.ndarray],
    exclude_masks: list[np.ndarray],
    manual_add: np.ndarray | None = None,
    manual_exclude: np.ndarray | None = None,
    forced_exclude_masks: list[np.ndarray] | None = None,
    manual_exclude_forced: bool = True,
) -> np.ndarray:
    """Compose automatic masks, then let manual add restore non-forced exclusions."""

    result = np.zeros(shape, dtype=np.uint8)
    for mask in apply_masks:
        if mask.shape != shape:
            raise ValueError("apply mask dimensions do not match the source image")
        result = np.maximum(result, np.asarray(mask > 0, dtype=np.uint8) * 255)
    exclusions = np.zeros(shape, dtype=np.uint8)
    for mask in exclude_masks:
        if mask.shape != shape:
            raise ValueError("exclude mask dimensions do not match the source image")
        exclusions = np.maximum(exclusions, np.asarray(mask > 0, dtype=np.uint8) * 255)
    if manual_exclude is not None:
        if manual_exclude.shape != shape:
            raise ValueError("manual exclude mask dimensions do not match the source image")
        exclusions = np.maximum(exclusions, np.asarray(manual_exclude > 0, dtype=np.uint8) * 255)
    result[exclusions > 0] = 0
    if manual_add is not None:
        if manual_add.shape != shape:
            raise ValueError("manual add mask dimensions do not match the source image")
        result = np.maximum(result, np.asarray(manual_add > 0, dtype=np.uint8) * 255)
    for mask in forced_exclude_masks or []:
        if mask.shape != shape:
            raise ValueError("forced exclude mask dimensions do not match the source image")
        result[np.asarray(mask) > 0] = 0
    if manual_exclude is not None and manual_exclude_forced:
        result[manual_exclude > 0] = 0
    return result
