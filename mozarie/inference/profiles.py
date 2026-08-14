"""Strict, non-inference contracts for Mozarie ONNX models."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import onnx


TARGET_CLASS_MAP = ("anus", "nipple", "penis", "vagina", "female face", "male face", "pubic hair")
TARGET_ROW_CHANNELS = 4 + len(TARGET_CLASS_MAP) + 32


class ModelProfileError(ValueError):
    """An ONNX graph cannot be decoded by Mozarie's fixed adapters."""


@dataclass(frozen=True)
class TensorProfile:
    name: str
    dimensions: tuple[int | None, ...]


@dataclass(frozen=True)
class ModelProfile:
    kind: str
    input: TensorProfile
    outputs: tuple[TensorProfile, ...]


def _dimensions(value_info: onnx.ValueInfoProto) -> tuple[int | None, ...]:
    tensor = value_info.type.tensor_type
    if not tensor.HasField("shape"):
        raise ModelProfileError(f"{value_info.name}: tensor shape is required")
    result: list[int | None] = []
    for dimension in tensor.shape.dim:
        result.append(int(dimension.dim_value) if dimension.HasField("dim_value") and dimension.dim_value > 0 else None)
    return tuple(result)


def _load(path: Path) -> tuple[TensorProfile, tuple[TensorProfile, ...]]:
    try:
        graph = onnx.load(str(path), load_external_data=False).graph
    except Exception as exc:
        raise ModelProfileError(f"ONNXファイルを読めません: {exc}") from exc
    inputs = tuple(TensorProfile(item.name, _dimensions(item)) for item in graph.input)
    outputs = tuple(TensorProfile(item.name, _dimensions(item)) for item in graph.output)
    if len(inputs) != 1:
        raise ModelProfileError("入力は1個の画像テンソルだけに対応しています")
    image_input = inputs[0]
    if len(image_input.dimensions) != 4 or image_input.dimensions[1] not in {None, 3}:
        raise ModelProfileError("入力は [batch, 3, height, width] のRGB NCHW形式が必要です")
    return image_input, outputs


def _has_dimension(profile: TensorProfile, value: int) -> bool:
    return value in profile.dimensions


def validate_target_profile(path: Path) -> ModelProfile:
    """Validate the fixed 7-class YOLO segmentation profile Mozarie supports."""
    image_input, outputs = _load(path)
    if len(outputs) != 2:
        raise ModelProfileError("対象セグメンテーションは予測テンソルと32chプロトタイプの2出力が必要です")
    prediction = next((item for item in outputs if len(item.dimensions) == 3 and _has_dimension(item, TARGET_ROW_CHANNELS)), None)
    prototype = next((item for item in outputs if len(item.dimensions) == 4 and item.dimensions[1] in {None, 32}), None)
    if prediction is None:
        raise ModelProfileError(f"対象予測は {TARGET_ROW_CHANNELS}ch (4 box + 7 class + 32 mask) のrank 3出力が必要です")
    if prototype is None:
        raise ModelProfileError("対象プロトタイプは [batch, 32, height, width] のrank 4出力が必要です")
    return ModelProfile("target_segmentation", image_input, outputs)


def validate_hand_profile(path: Path) -> ModelProfile:
    """Validate the one-class YOLO hand detector profile Mozarie supports."""
    image_input, outputs = _load(path)
    if len(outputs) != 1:
        raise ModelProfileError("手検出は1個の予測出力だけに対応しています")
    output = outputs[0]
    if len(output.dimensions) != 3 or output.dimensions[-1] not in {None, 5}:
        raise ModelProfileError("手検出の出力は [batch, anchors, 5] (xywh + score) が必要です")
    return ModelProfile("hand_detection", image_input, outputs)


def profile_summary(profile: ModelProfile) -> dict[str, object]:
    return {"kind": profile.kind, "input": list(profile.input.dimensions), "outputs": [list(item.dimensions) for item in profile.outputs]}
