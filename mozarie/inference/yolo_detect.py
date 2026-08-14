"""Decoder for the hand detector ONNX export."""

from __future__ import annotations

from pathlib import Path

import numpy as np

from .onnx import BaseOnnxModel, letterbox_bgr, nms_indices, restore_box


class HandDetector(BaseOnnxModel):
    def __init__(self, path: Path, *, device: str = "gpu", input_size: int = 640) -> None:
        super().__init__(path, device=device)
        self.input_size = input_size

    def detect_boxes(self, rgb: np.ndarray, confidence: float) -> list[tuple[int, int, int, int]]:
        tensor, transform = letterbox_bgr(rgb, self.input_size)
        output = self.run(tensor)[0]
        rows = np.asarray(output)[0]
        if rows.ndim != 2:
            raise ValueError("Hand output must be rank 3")
        if rows.shape[0] == 5:
            rows = rows.T
        elif rows.shape[1] != 5:
            raise ValueError("Hand output must have a 5-channel axis")
        boxes: list[tuple[int, int, int, int]] = []
        scores: list[float] = []
        for row in rows:
            if row.shape[0] < 5:
                continue
            # The exported hand model is one-class.  Accept either xywh+score
            # or xyxy+score; its values are constrained through letterbox.
            score = float(row[4] if row.shape[0] == 5 else np.max(row[4:]))
            if score < confidence:
                continue
            box = restore_box(row[:4], transform, xywh=True)
            if box is None:
                continue
            boxes.append(box); scores.append(score)
        return [boxes[index] for index in nms_indices(boxes, scores, 0.70)]
