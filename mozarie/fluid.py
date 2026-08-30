"""Lightweight white-fluid exclusion detection."""

from __future__ import annotations

import heapq
import math

import cv2
import numpy as np


__all__ = ["white_fluid_mask"]


_MAX_STRICT_COMPONENTS = 8
_MAX_BROAD_COMPONENTS = 4
_MAX_COMPONENT_RATIO = 0.15
_MAX_TOTAL_RATIO = 0.20


def white_fluid_mask(rgb: np.ndarray, penis_mask: np.ndarray) -> np.ndarray:
    """Find neutral-white fluid regions inside one final target segment."""
    penis = np.asarray(penis_mask > 0, dtype=np.uint8)
    penis_area = int(np.count_nonzero(penis))
    empty = np.zeros_like(penis, dtype=np.uint8)
    if penis_area == 0:
        return empty

    rows, columns = np.nonzero(penis)
    top, bottom = int(rows.min()), int(rows.max()) + 1
    left, right = int(columns.min()), int(columns.max()) + 1
    crop_penis = penis[top:bottom, left:right]
    pixels = np.asarray(rgb)[top:bottom, left:right]
    hsv = cv2.cvtColor(pixels, cv2.COLOR_RGB2HSV)
    saturation, value = hsv[:, :, 1], hsv[:, :, 2]
    channel_min = pixels.min(axis=2)
    channel_spread = pixels.max(axis=2) - channel_min
    candidate = (crop_penis > 0) & (saturation <= 80) & (value >= 180) & (channel_spread <= 24) & (channel_min >= 215)
    seed = candidate & (saturation <= 45) & (value >= 225) & (channel_spread <= 18) & (channel_min >= 230)
    closed = cv2.morphologyEx(candidate.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), dtype=np.uint8)) > 0
    count, labels, _stats, _centroids = cv2.connectedComponentsWithStats(closed.astype(np.uint8), connectivity=8)
    minimum = max(4, math.ceil(penis_area * 0.001))
    maximum = math.floor(penis_area * _MAX_COMPONENT_RATIO)
    total_cap = math.floor(penis_area * _MAX_TOTAL_RATIO)
    flat_labels = np.asarray(labels).ravel()
    areas = np.bincount(flat_labels[candidate.ravel()], minlength=count)
    seed_counts = np.bincount(flat_labels[seed.ravel()], minlength=count)
    eligible = [
        label
        for label in range(1, count)
        if minimum <= areas[label] <= maximum and seed_counts[label] >= 2 and seed_counts[label] / areas[label] >= 0.10
    ]
    candidates = heapq.nlargest(_MAX_STRICT_COMPONENTS, eligible, key=lambda label: (areas[label], -label))
    selected_labels: list[int] = []
    selected_area = 0
    for label in candidates:
        area = int(areas[label])
        if selected_area + area > total_cap:
            continue
        selected_labels.append(label)
        selected_area += area

    strict_selected = np.isin(labels, selected_labels) & candidate & (crop_penis > 0)

    # Expand only from an already accepted strict-white deposit.  The looser
    # neutral gate admits translucent material, while the local brightness
    # checks keep an isolated pale highlight out.
    loose_candidate = (
        (crop_penis > 0)
        & (saturation <= 70)
        & (value >= 190)
        & (channel_spread <= 24)
        & (channel_min >= 185)
    )
    top_hat = np.maximum(
        cv2.morphologyEx(value, cv2.MORPH_TOPHAT, np.ones((7, 7), dtype=np.uint8)),
        cv2.morphologyEx(value, cv2.MORPH_TOPHAT, np.ones((15, 15), dtype=np.uint8)),
    )
    local_residual = cv2.subtract(value, cv2.blur(value, (9, 9)))
    bright_residual = np.maximum(top_hat, local_residual)
    loose_closed = cv2.morphologyEx(loose_candidate.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), dtype=np.uint8)) > 0
    broad_count, broad_labels, _stats, _centroids = cv2.connectedComponentsWithStats(loose_closed.astype(np.uint8), connectivity=8)
    broad_flat_labels = np.asarray(broad_labels).ravel()
    loose_areas = np.bincount(broad_flat_labels[loose_candidate.ravel()], minlength=broad_count)
    anchor_counts = np.bincount(broad_flat_labels[(loose_candidate & strict_selected).ravel()], minlength=broad_count)
    new_pixels = loose_candidate & ~strict_selected
    new_areas = np.bincount(broad_flat_labels[new_pixels.ravel()], minlength=broad_count)
    contrast_counts = np.bincount(
        broad_flat_labels[(loose_candidate & (bright_residual >= 20)).ravel()], minlength=broad_count
    )
    residual_sums = np.bincount(
        broad_flat_labels[loose_candidate.ravel()], weights=bright_residual[loose_candidate].ravel(), minlength=broad_count
    )
    broad_eligible = [
        label
        for label in range(1, broad_count)
        if minimum <= loose_areas[label] <= total_cap
        and anchor_counts[label] >= 2
        and new_areas[label] > 0
        and contrast_counts[label] >= max(2, math.ceil(loose_areas[label] * 0.05))
        and residual_sums[label] / loose_areas[label] >= 10
    ]
    broad_candidates = heapq.nlargest(
        _MAX_BROAD_COMPONENTS, broad_eligible, key=lambda label: (contrast_counts[label], new_areas[label], -label)
    )
    broad_selected_labels: list[int] = []
    for label in broad_candidates:
        area = int(new_areas[label])
        if selected_area + area > total_cap:
            continue
        broad_selected_labels.append(label)
        selected_area += area

    selected = strict_selected | (np.isin(broad_labels, broad_selected_labels) & loose_candidate)
    empty[top:bottom, left:right] = np.asarray(selected, dtype=np.uint8) * 255
    return empty
