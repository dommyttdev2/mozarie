"""Decoder for the hand detector ONNX export."""

from __future__ import annotations

from pathlib import Path

import numpy as np

from .onnx import BaseOnnxModel, letterbox_bgr, nms_indices, restore_box


class HandDetector(BaseOnnxModel):
    def __init__(self, path: Path, *, device: str = "gpu", input_size: int = 640) -> None:
        super().__init__(path, device=device)
        self.input_size = input_size

    @staticmethod
    def _prediction_rows(outputs: list[np.ndarray]) -> np.ndarray:
        """Validate Mozarie's one-class xywh-plus-score hand output before decoding."""
        if len(outputs) != 1:
            raise ValueError("Hand detection needs exactly one output")
        output = np.asarray(outputs[0])
        if output.dtype != np.float32:
            raise ValueError("Hand output must use float32")
        if output.ndim != 3 or output.shape[0] != 1:
            raise ValueError("Hand output must be rank 3 with batch size 1")
        channel_axes = sum(dimension == 5 for dimension in output.shape[1:])
        if channel_axes != 1:
            raise ValueError("Hand output must have exactly one 5-channel axis")
        rows = output[0].T if output.shape[1] == 5 else output[0]
        if rows.shape[0] == 0:
            raise ValueError("Hand output must contain at least one anchor")
        if not np.isfinite(rows).all():
            raise ValueError("Hand output contains non-finite values")
        scores = rows[:, 4]
        if np.any((scores < 0.0) | (scores > 1.0)):
            raise ValueError("Hand output scores must be between 0 and 1")
        return rows

    def detect_boxes(self, rgb: np.ndarray, confidence: float) -> list[tuple[int, int, int, int]]:
        tensor, transform = letterbox_bgr(rgb, self.input_size)
        rows = self._prediction_rows(self.run(tensor))
        boxes: list[tuple[int, int, int, int]] = []
        scores: list[float] = []
        for row in rows:
            if row.shape[0] < 5:
                continue
            # Mozarie accepts the fixed one-class xywh-plus-score export only.
            score = float(row[4])
            if score < confidence:
                continue
            box = restore_box(row[:4], transform, xywh=True)
            if box is None:
                continue
            boxes.append(box); scores.append(score)
        return [boxes[index] for index in nms_indices(boxes, scores, 0.70)]
