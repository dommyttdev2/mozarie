"""Adapter for raw Ultralytics YOLO segmentation ONNX exports."""

from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from .onnx import BaseOnnxModel, Letterbox, class_aware_nms_indices, letterbox_bgr, restore_box, sigmoid
from .profiles import yolo_class_names


class GenericYoloSegmenter(BaseOnnxModel):
    """Decode a 1024px Ultralytics segment export using its embedded class names."""

    def __init__(self, path: Path, *, device: str = "gpu", gpu_device: int = 0, input_size: int = 1024) -> None:
        super().__init__(path, device=device, gpu_device=gpu_device)
        self.input_size = input_size
        self.class_names = yolo_class_names(dict(self.session.get_modelmeta().custom_metadata_map))

    def _prediction_rows(self, output: np.ndarray) -> np.ndarray:
        rows = np.asarray(output)
        channels = 4 + len(self.class_names) + 32
        if rows.ndim != 3 or rows.shape[0] != 1:
            raise ValueError("Segmentation prediction output must be rank 3 with batch size 1")
        if rows.shape[1] == channels:
            return rows[0].T
        if rows.shape[2] == channels:
            return rows[0]
        raise ValueError("Segmentation prediction output has no expected channel axis")

    def _outputs(self, values: list[np.ndarray]) -> tuple[np.ndarray, np.ndarray]:
        channels = 4 + len(self.class_names) + 32
        prediction = next(
            (value for value in values if np.asarray(value).ndim == 3 and channels in np.asarray(value).shape[1:]),
            None,
        )
        prototype = next(
            (value for value in values if np.asarray(value).ndim == 4 and np.asarray(value).shape[1] == 32),
            None,
        )
        if prediction is None or prototype is None:
            raise ValueError("Segmentation outputs do not match the Ultralytics profile")
        return np.asarray(prediction), np.asarray(prototype)

    @staticmethod
    def _mask_from_coefficients(coefficients: np.ndarray, proto: np.ndarray, box: tuple[int, int, int, int], letterbox: Letterbox) -> np.ndarray:
        prototype = np.asarray(proto)[0]
        logits = coefficients @ prototype.reshape(prototype.shape[0], -1)
        low_res = sigmoid(logits).reshape(prototype.shape[1:])
        full = cv2.resize(low_res, (letterbox.input_width, letterbox.input_height), interpolation=cv2.INTER_LINEAR)
        cropped = full[
            letterbox.pad_y:letterbox.pad_y + round(letterbox.source_height * letterbox.scale),
            letterbox.pad_x:letterbox.pad_x + round(letterbox.source_width * letterbox.scale),
        ]
        restored = cv2.resize(cropped, (letterbox.source_width, letterbox.source_height), interpolation=cv2.INTER_LINEAR)
        left, top, right, bottom = box
        constrained = np.zeros_like(restored, dtype=np.uint8)
        constrained[top:bottom, left:right] = (restored[top:bottom, left:right] >= 0.5).astype(np.uint8) * 255
        return constrained

    def detect(self, rgb: np.ndarray, confidence: float, source: str, targets: set[str] | None = None) -> list[dict[str, object]]:
        targets = targets or {"penis", "pussy"}
        tensor, transform = letterbox_bgr(rgb, self.input_size)
        prediction, prototype = self._outputs(self.run(tensor))
        boxes: list[tuple[int, int, int, int]] = []
        scores: list[float] = []
        classes: list[str] = []
        coefficients: list[np.ndarray] = []
        class_count = len(self.class_names)
        for row in self._prediction_rows(prediction):
            class_id = int(np.argmax(row[4:4 + class_count]))
            raw_name = self.class_names[class_id]
            class_name = "pussy" if raw_name in {"pussy", "vagina"} else "penis" if raw_name == "penis" else None
            score = float(row[4 + class_id])
            if class_name not in targets or score < confidence:
                continue
            box = restore_box(row[:4], transform, xywh=True)
            if box is None:
                continue
            boxes.append(box)
            scores.append(score)
            classes.append(class_name)
            coefficients.append(np.asarray(row[4 + class_count:4 + class_count + 32], dtype=np.float32))
        return [
            {
                "class_name": classes[index],
                "confidence": scores[index],
                "mask": self._mask_from_coefficients(coefficients[index], prototype, boxes[index], transform),
                "source": source,
            }
            for index in class_aware_nms_indices(boxes, scores, classes, 0.85)
        ]
