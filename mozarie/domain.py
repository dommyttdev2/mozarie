"""Small, serialisable domain types for Mozarie."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path


class CandidateRole(StrEnum):
    """How a candidate contributes to the final mosaic mask."""

    APPLY = "apply"
    EXCLUDE = "exclude"


@dataclass
class Candidate:
    """A cached mask proposed by automatic, boundary or manual editing."""

    candidate_id: str
    class_name: str
    confidence: float | None
    mask_path: Path
    enabled: bool = True
    color: str = "#5bb6d5"
    source: str = "auto"
    refinement: str | None = None
    role: CandidateRole = CandidateRole.APPLY

    def as_api_dict(self, source_label: str, refinement_label: str = "") -> dict[str, object]:
        return {
            "id": self.candidate_id,
            "className": self.class_name,
            "confidence": self.confidence,
            "enabled": self.enabled,
            "color": self.color,
            "source": self.source,
            "sourceLabel": source_label,
            "refinement": self.refinement,
            "refinementLabel": refinement_label,
            "role": self.role.value,
        }
