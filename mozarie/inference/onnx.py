"""Direct ONNX Runtime helpers for the Mozarie detection models."""

from __future__ import annotations

from dataclasses import dataclass
import ctypes
import importlib.util
import os
from pathlib import Path
from typing import Any

import cv2
import numpy as np


_dll_directory_handles: list[object] = []
_cuda_runtime_handles: list[object] = []


def _register_torch_dll_directory() -> None:
    """Keep PyTorch's CUDA runtime DLLs visible to ONNX Runtime on Windows."""
    if os.name != "nt":
        return
    torch_spec = importlib.util.find_spec("torch")
    if torch_spec is None or torch_spec.origin is None:
        return
    directory = Path(torch_spec.origin).parent / "lib"
    if directory.is_dir():
        _dll_directory_handles.append(os.add_dll_directory(str(directory)))
        nvrtc = next((path for path in directory.glob("nvrtc64_*_0.dll") if not path.name.endswith(".alt.dll")), None)
        if nvrtc is not None:
            try:
                _cuda_runtime_handles.append(ctypes.WinDLL(str(nvrtc)))
            except OSError:
                pass


_register_torch_dll_directory()

import onnxruntime as ort

preload_dlls = getattr(ort, "preload_dlls", None)
if preload_dlls is not None:
    preload_dlls()


@dataclass(frozen=True)
class Letterbox:
    scale: float
    pad_x: int
    pad_y: int
    input_width: int
    input_height: int
    source_width: int
    source_height: int


def available_providers(device: str, gpu_device: int = 0) -> list[object]:
    available = set(ort.get_available_providers())
    if device.lower() == "cpu":
        return ["CPUExecutionProvider"]
    if "CUDAExecutionProvider" not in available:
        raise RuntimeError("CUDAExecutionProvider is unavailable. Select CPU or install ONNX Runtime GPU.")
    return [(
        "CUDAExecutionProvider",
        {
            "device_id": int(gpu_device),
            "arena_extend_strategy": "kSameAsRequested",
            "cudnn_conv_algo_search": "HEURISTIC",
            "cudnn_conv_use_max_workspace": "0",
            "do_copy_in_default_stream": "1",
        },
    ), "CPUExecutionProvider"]


def create_session(path: Path, device: str = "gpu", gpu_device: int = 0) -> ort.InferenceSession:
    if not path.is_file():
        raise FileNotFoundError(path)
    options = ort.SessionOptions()
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    session = ort.InferenceSession(str(path), sess_options=options, providers=available_providers(device, gpu_device))
    if device.lower() != "cpu" and session.get_providers()[0] != "CUDAExecutionProvider":
        raise RuntimeError("CUDAExecutionProvider could not create the ONNX inference session.")
    return session


def letterbox_bgr(rgb: np.ndarray, size: int) -> tuple[np.ndarray, Letterbox]:
    height, width = rgb.shape[:2]
    scale = min(size / width, size / height)
    resized_width, resized_height = max(1, round(width * scale)), max(1, round(height * scale))
    resized = cv2.resize(rgb, (resized_width, resized_height), interpolation=cv2.INTER_LINEAR)
    pad_x, pad_y = (size - resized_width) // 2, (size - resized_height) // 2
    canvas = np.full((size, size, 3), 114, dtype=np.uint8)
    canvas[pad_y:pad_y + resized_height, pad_x:pad_x + resized_width] = resized
    tensor = np.ascontiguousarray(canvas.transpose(2, 0, 1)[None], dtype=np.float32) / 255.0
    return tensor, Letterbox(scale, pad_x, pad_y, size, size, width, height)


def restore_box(box: np.ndarray, letterbox: Letterbox, *, xywh: bool = True) -> tuple[int, int, int, int] | None:
    values = np.asarray(box, dtype=np.float32).copy()
    if xywh:
        values = np.asarray((values[0] - values[2] / 2, values[1] - values[3] / 2, values[0] + values[2] / 2, values[1] + values[3] / 2))
    values[[0, 2]] = (values[[0, 2]] - letterbox.pad_x) / letterbox.scale
    values[[1, 3]] = (values[[1, 3]] - letterbox.pad_y) / letterbox.scale
    left, top = np.floor(values[:2]).astype(int)
    right, bottom = np.ceil(values[2:]).astype(int)
    left, top = max(0, left), max(0, top)
    right, bottom = min(letterbox.source_width, right), min(letterbox.source_height, bottom)
    return (left, top, right, bottom) if right > left and bottom > top else None


def nms_indices(boxes: list[tuple[int, int, int, int]], scores: list[float], iou_threshold: float = 0.7) -> list[int]:
    if not boxes:
        return []
    indexed = sorted(range(len(boxes)), key=lambda index: scores[index], reverse=True)
    selected: list[int] = []
    while indexed:
        current = indexed.pop(0)
        selected.append(current)
        left, top, right, bottom = boxes[current]
        area = max(1, (right - left) * (bottom - top))
        survivors: list[int] = []
        for other in indexed:
            other_left, other_top, other_right, other_bottom = boxes[other]
            overlap_left, overlap_top = max(left, other_left), max(top, other_top)
            overlap_right, overlap_bottom = min(right, other_right), min(bottom, other_bottom)
            overlap = max(0, overlap_right - overlap_left) * max(0, overlap_bottom - overlap_top)
            other_area = max(1, (other_right - other_left) * (other_bottom - other_top))
            if overlap / (area + other_area - overlap) <= iou_threshold:
                survivors.append(other)
        indexed = survivors
    return selected


def class_aware_nms_indices(
    boxes: list[tuple[int, int, int, int]],
    scores: list[float],
    classes: list[object],
    iou_threshold: float = 0.7,
) -> list[int]:
    selected: list[int] = []
    for class_name in dict.fromkeys(classes):
        class_indices = [index for index, value in enumerate(classes) if value == class_name]
        class_boxes = [boxes[index] for index in class_indices]
        class_scores = [scores[index] for index in class_indices]
        selected.extend(class_indices[index] for index in nms_indices(class_boxes, class_scores, iou_threshold))
    return sorted(selected, key=lambda index: scores[index], reverse=True)


def sigmoid(values: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.clip(values, -60, 60)))


class BaseOnnxModel:
    def __init__(self, path: Path, *, device: str = "gpu", gpu_device: int = 0) -> None:
        self.path = path
        self.device = device
        self.session = create_session(path, device, gpu_device)
        self.input_name = self.session.get_inputs()[0].name

    def run(self, tensor: np.ndarray) -> list[np.ndarray]:
        return [np.asarray(value) for value in self.session.run(None, {self.input_name: tensor})]

    @property
    def providers(self) -> tuple[str, ...]:
        return tuple(self.session.get_providers())
