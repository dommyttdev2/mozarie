"""Runtime types shared by the state mixins without importing the HTTP layer."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .inference.generic_yolo_segment import GenericYoloSegmenter
    from .inference.yolo_detect import HandDetector
    from .inference.yolo_segment import TargetSegmenter


@dataclass
class DetectionModels:
    target: TargetSegmenter
    auxiliaries: list[tuple[str, GenericYoloSegmenter]] = field(default_factory=list)
    hand: HandDetector | None = None
