"""Strict, non-inference contracts for Mozarie ONNX models."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import onnx
from onnx import TensorProto


TARGET_CLASS_MAP = ("anus", "nipple", "penis", "vagina", "female face", "male face", "pubic hair")
TARGET_ROW_CHANNELS = 4 + len(TARGET_CLASS_MAP) + 32


class ModelProfileError(ValueError):
    """An ONNX graph cannot be decoded by Mozarie's fixed adapters."""


@dataclass(frozen=True)
class TensorProfile:
    name: str
    dimensions: tuple[int | None, ...]
    dtype: int


@dataclass(frozen=True)
class ModelProfile:
    kind: str
    input: TensorProfile
    outputs: tuple[TensorProfile, ...]


def _dimensions(value_info: onnx.ValueInfoProto) -> tuple[int | None, ...]:
    tensor = value_info.type.tensor_type
    if not tensor.HasField("shape"):
        raise ModelProfileError(f"{value_info.name}: tensor shape is required")
    return tuple(
        int(dimension.dim_value) if dimension.HasField("dim_value") and dimension.dim_value > 0 else None
        for dimension in tensor.shape.dim
    )


def _tensor_profile(value_info: onnx.ValueInfoProto) -> TensorProfile:
    tensor = value_info.type.tensor_type
    if not tensor.HasField("elem_type"):
        raise ModelProfileError(f"{value_info.name}: tensor dtype is required")
    return TensorProfile(value_info.name, _dimensions(value_info), tensor.elem_type)


def _load(path: Path, *, expected_size: int) -> tuple[TensorProfile, tuple[TensorProfile, ...]]:
    try:
        graph = onnx.load(str(path), load_external_data=False).graph
    except Exception as exc:
        raise ModelProfileError(f"Could not read ONNX file: {exc}") from exc
    inputs = tuple(_tensor_profile(item) for item in graph.input)
    outputs = tuple(_tensor_profile(item) for item in graph.output)
    if len(inputs) != 1:
        raise ModelProfileError("Exactly one image input is required")
    image_input = inputs[0]
    if len(image_input.dimensions) != 4 or image_input.dimensions[1] != 3:
        raise ModelProfileError("Input must be NCHW with exactly 3 RGB channels")
    if image_input.dtype != TensorProto.FLOAT:
        raise ModelProfileError("Input must use float32 tensors")
    height, width = image_input.dimensions[2:]
    if (height is not None and height != expected_size) or (width is not None and width != expected_size):
        raise ModelProfileError(f"Input size must be dynamic or {expected_size}x{expected_size}")
    return image_input, outputs


def _has_dimension(profile: TensorProfile, value: int) -> bool:
    return value in profile.dimensions


def validate_target_profile(path: Path) -> ModelProfile:
    """Validate Mozarie's fixed 7-class, 32-mask YOLO segmentation profile."""
    image_input, outputs = _load(path, expected_size=1280)
    if len(outputs) != 2:
        raise ModelProfileError("Target segmentation needs prediction and 32-channel prototype outputs")
    prediction = next((item for item in outputs if len(item.dimensions) == 3 and _has_dimension(item, TARGET_ROW_CHANNELS)), None)
    prototype = next((item for item in outputs if len(item.dimensions) == 4 and item.dimensions[1] == 32), None)
    if prediction is None:
        raise ModelProfileError(f"Target prediction must be rank 3 with a {TARGET_ROW_CHANNELS}-channel axis")
    if prototype is None:
        raise ModelProfileError("Target prototype must be [batch, 32, height, width]")
    return ModelProfile("target_segmentation", image_input, outputs)


def validate_hand_profile(path: Path) -> ModelProfile:
    """Validate one-class hand detector profiles in either supported orientation."""
    image_input, outputs = _load(path, expected_size=640)
    if len(outputs) != 1:
        raise ModelProfileError("Hand detection needs one output")
    output = outputs[0]
    if len(output.dimensions) != 3 or (output.dimensions[1] != 5 and output.dimensions[2] != 5):
        raise ModelProfileError("Hand output must be [batch, 5, anchors] or [batch, anchors, 5]")
    return ModelProfile("hand_detection", image_input, outputs)


def profile_summary(profile: ModelProfile) -> dict[str, object]:
    return {
        "kind": profile.kind,
        "input": list(profile.input.dimensions),
        "outputs": [list(item.dimensions) for item in profile.outputs],
    }
