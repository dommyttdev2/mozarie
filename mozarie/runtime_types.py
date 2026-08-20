"""Runtime types shared by the state mixins without importing the HTTP layer."""

from __future__ import annotations

from dataclasses import dataclass, field

from .core import GenericYoloSegmenter, HandDetector, TargetSegmenter


@dataclass
class DetectionModels:
    target: TargetSegmenter
    auxiliaries: list[tuple[str, GenericYoloSegmenter]] = field(default_factory=list)
    hand: HandDetector | None = None
