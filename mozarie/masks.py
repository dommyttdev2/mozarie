"""Mask composition helpers used by preview and file save paths."""

from __future__ import annotations

import numpy as np


def compose_masks(
    shape: tuple[int, int],
    apply_masks: list[np.ndarray],
    exclude_masks: list[np.ndarray],
    manual_add: np.ndarray | None = None,
    manual_exclude: np.ndarray | None = None,
    force_exclusion: bool = True,
) -> np.ndarray:
    """Return the enabled apply masks minus the requested exclusions."""

    result = np.zeros(shape, dtype=np.uint8)
    for mask in apply_masks:
        if mask.shape != shape:
            raise ValueError("apply mask dimensions do not match the source image")
        result = np.maximum(result, np.asarray(mask > 0, dtype=np.uint8) * 255)
    if manual_add is not None:
        if manual_add.shape != shape:
            raise ValueError("manual add mask dimensions do not match the source image")
        result = np.maximum(result, np.asarray(manual_add > 0, dtype=np.uint8) * 255)

    exclusions = np.zeros(shape, dtype=np.uint8)
    if force_exclusion:
        for mask in exclude_masks:
            if mask.shape != shape:
                raise ValueError("exclude mask dimensions do not match the source image")
            exclusions = np.maximum(exclusions, np.asarray(mask > 0, dtype=np.uint8) * 255)
    if manual_exclude is not None:
        if manual_exclude.shape != shape:
            raise ValueError("manual exclude mask dimensions do not match the source image")
        exclusions = np.maximum(exclusions, np.asarray(manual_exclude > 0, dtype=np.uint8) * 255)

    result[exclusions > 0] = 0
    return result
