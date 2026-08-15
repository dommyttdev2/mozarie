"""Strict, non-inference contracts for Mozarie ONNX models."""

from __future__ import annotations

import ast
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


def _load(path: Path, *, expected_size: int) -> tuple[TensorProfile, tuple[TensorProfile, ...], dict[str, str]]:
    try:
        model = onnx.load(str(path), load_external_data=False)
    except Exception as exc:
        raise ModelProfileError(f"Could not read ONNX file: {exc}") from exc
    graph = model.graph
    inputs = tuple(_tensor_profile(item) for item in graph.input)
    outputs = tuple(_tensor_profile(item) for item in graph.output)
    if len(inputs) != 1:
        raise ModelProfileError("Exactly one image input is required")
    image_input = inputs[0]
    if len(image_input.dimensions) != 4 or image_input.dimensions[1] != 3:
        raise ModelProfileError("Input must be NCHW with exactly 3 RGB channels")
    if image_input.dtype != TensorProto.FLOAT:
        raise ModelProfileError("Input must use float32 tensors")
    if image_input.dimensions[0] not in {None, 1}:
        raise ModelProfileError("Input batch size must be 1 or dynamic")
    height, width = image_input.dimensions[2:]
    if (height is not None and height != expected_size) or (width is not None and width != expected_size):
        raise ModelProfileError(f"Input size must be dynamic or {expected_size}x{expected_size}")
    return image_input, outputs, {item.key: item.value for item in model.metadata_props}


def _is_float32_single_batch(profile: TensorProfile) -> bool:
    return (
        len(profile.dimensions) >= 1
        and profile.dtype == TensorProto.FLOAT
        and profile.dimensions[0] in {None, 1}
    )


def validate_target_profile(path: Path) -> ModelProfile:
    """Validate Mozarie's fixed 7-class, 32-mask YOLO segmentation profile."""
    image_input, outputs, _ = _load(path, expected_size=1280)
    if len(outputs) != 2:
        raise ModelProfileError("Target segmentation needs prediction and 32-channel prototype outputs")
    prediction = next(
        (
            item for item in outputs
            if len(item.dimensions) == 3
            and _is_float32_single_batch(item)
            and (item.dimensions[1] == TARGET_ROW_CHANNELS or item.dimensions[2] == TARGET_ROW_CHANNELS)
        ),
        None,
    )
    prototype = next((item for item in outputs if len(item.dimensions) == 4 and _is_float32_single_batch(item) and item.dimensions[1] == 32), None)
    if prediction is None:
        raise ModelProfileError(f"Target prediction must be rank 3 with a {TARGET_ROW_CHANNELS}-channel axis")
    if prototype is None:
        raise ModelProfileError("Target prototype must be [batch, 32, height, width]")
    return ModelProfile("target_segmentation", image_input, outputs)


def _normalise_class_name(value: object) -> str:
    return " ".join(str(value).strip().lower().replace("_", " ").replace("-", " ").split())


def yolo_class_names(metadata: dict[str, str]) -> tuple[str, ...]:
    """Read the ordered class names embedded by a standard Ultralytics ONNX export."""
    try:
        raw_names = ast.literal_eval(metadata["names"])
    except (KeyError, SyntaxError, ValueError, TypeError) as exc:
        raise ModelProfileError("Segmentation model requires parseable names metadata") from exc
    if isinstance(raw_names, dict):
        items = sorted(raw_names.items())
        if [index for index, _name in items] != list(range(len(items))):
            raise ModelProfileError("Segmentation names metadata must use consecutive integer class ids")
        names = [name for _index, name in items]
    elif isinstance(raw_names, (list, tuple)):
        names = list(raw_names)
    else:
        raise ModelProfileError("Segmentation names metadata must be a class-name list or map")
    if not names or any(not isinstance(name, str) or not name.strip() for name in names):
        raise ModelProfileError("Segmentation names metadata must contain non-empty class names")
    return tuple(_normalise_class_name(name) for name in names)


def validate_generic_yolo_segment_profile(path: Path) -> ModelProfile:
    """Validate the raw two-output Ultralytics segmentation export used by optional models."""
    image_input, outputs, metadata = _load(path, expected_size=1024)
    names = yolo_class_names(metadata)
    row_channels = 4 + len(names) + 32
    if len(outputs) != 2:
        raise ModelProfileError("Segmentation needs prediction and 32-channel prototype outputs")
    prediction = next(
        (
            item for item in outputs
            if len(item.dimensions) == 3
            and _is_float32_single_batch(item)
            and (item.dimensions[1] == row_channels or item.dimensions[2] == row_channels)
        ),
        None,
    )
    prototype = next(
        (item for item in outputs if len(item.dimensions) == 4 and _is_float32_single_batch(item) and item.dimensions[1] == 32),
        None,
    )
    if prediction is None:
        raise ModelProfileError(f"Segmentation prediction must be rank 3 with a {row_channels}-channel axis")
    if prototype is None:
        raise ModelProfileError("Segmentation prototype must be [batch, 32, height, width]")
    return ModelProfile("generic_yolo_segmentation", image_input, outputs)


def _validate_dynamic_hand_metadata(output_name: str, metadata: dict[str, str]) -> None:
    if output_name != "output0":
        raise ModelProfileError("Dynamic hand output must be named output0")
    try:
        names = ast.literal_eval(metadata["names"])
    except (KeyError, SyntaxError, ValueError, TypeError) as exc:
        raise ModelProfileError("Dynamic hand output requires parseable hand names metadata") from exc
    if not isinstance(names, dict) or len(names) != 1:
        raise ModelProfileError("Dynamic hand output requires names metadata {0: 'hand'}")
    class_id, class_name = next(iter(names.items()))
    if type(class_id) is not int or class_id != 0 or _normalise_class_name(class_name) != "hand":
        raise ModelProfileError("Dynamic hand output requires names metadata {0: 'hand'}")
    try:
        stride = int(metadata["stride"])
    except (KeyError, TypeError, ValueError) as exc:
        raise ModelProfileError("Dynamic hand output requires integer stride metadata") from exc
    if stride != 32:
        raise ModelProfileError("Dynamic hand output requires stride 32")
    task = metadata.get("task")
    if task is not None and task.strip().lower() != "detect":
        raise ModelProfileError("Dynamic hand output task must be detect")


def validate_hand_profile(path: Path) -> ModelProfile:
    """Validate one-class hand detector profiles in either supported orientation."""
    image_input, outputs, metadata = _load(path, expected_size=640)
    if len(outputs) != 1:
        raise ModelProfileError("Hand detection needs one output")
    output = outputs[0]
    if not _is_float32_single_batch(output) or len(output.dimensions) != 3:
        raise ModelProfileError("Hand output must be [batch, 5, anchors] or [batch, anchors, 5]")
    non_batch_dimensions = output.dimensions[1:]
    static_five_axes = sum(dimension == 5 for dimension in non_batch_dimensions)
    if static_five_axes == 1:
        return ModelProfile("hand_detection", image_input, outputs)
    if static_five_axes > 1 or all(dimension is not None for dimension in non_batch_dimensions):
        raise ModelProfileError("Hand output must have exactly one 5-channel axis")
    _validate_dynamic_hand_metadata(output.name, metadata)
    return ModelProfile("hand_detection", image_input, outputs)


def profile_summary(profile: ModelProfile) -> dict[str, object]:
    return {
        "kind": profile.kind,
        "input": list(profile.input.dimensions),
        "outputs": [list(item.dimensions) for item in profile.outputs],
    }
