"""Tracked defaults and private per-machine Mozarie settings."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any


class SettingsError(ValueError):
    """Raised when a browser-provided settings document is invalid."""


def _merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    result = copy.deepcopy(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(result.get(key), dict):
            result[key] = _merge(result[key], value)
        else:
            result[key] = value
    return result


class SettingsStore:
    def __init__(self, app_dir: Path) -> None:
        self.defaults_path = app_dir / "config" / "defaults.json"
        self.local_path = app_dir / "config" / "local.json"

    def load(self) -> dict[str, Any]:
        defaults = json.loads(self.defaults_path.read_text(encoding="utf-8"))
        if not self.local_path.is_file():
            return defaults
        return _merge(defaults, json.loads(self.local_path.read_text(encoding="utf-8")))

    def save(self, update: dict[str, Any]) -> dict[str, Any]:
        settings = validate_settings(_merge(self.load(), update))
        self.local_path.parent.mkdir(parents=True, exist_ok=True)
        self.local_path.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return settings

    def reset(self) -> dict[str, Any]:
        """Forget only this machine's override and return tracked defaults."""
        self.local_path.unlink(missing_ok=True)
        return self.load()


def _expect_dict(value: Any, name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SettingsError(f"{name} must be an object")
    return value


def _expect_bool(value: Any, name: str) -> bool:
    if not isinstance(value, bool):
        raise SettingsError(f"{name} must be a boolean")
    return value


def _expect_number(value: Any, name: str, minimum: float, maximum: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not minimum <= float(value) <= maximum:
        raise SettingsError(f"{name} must be between {minimum} and {maximum}")
    return float(value)


def _expect_color(value: Any, name: str) -> str:
    if not isinstance(value, str) or len(value) != 7 or not value.startswith("#"):
        raise SettingsError(f"{name} must be a #RRGGBB color")
    try:
        int(value[1:], 16)
    except ValueError as exc:
        raise SettingsError(f"{name} must be a #RRGGBB color") from exc
    return value.lower()


def validate_settings(value: Any) -> dict[str, Any]:
    """Validate the small portable settings surface before persisting it."""
    settings = _expect_dict(value, "settings")
    general = _expect_dict(settings.get("general"), "general")
    models = _expect_dict(settings.get("models"), "models")
    display = _expect_dict(settings.get("display"), "display")
    detection = _expect_dict(settings.get("detection"), "detection")
    language = general.get("language")
    if language not in {"ja", "en"}:
        raise SettingsError("general.language must be ja or en")
    port = _expect_number(general.get("port"), "general.port", 1024, 65535)
    provider = models.get("provider")
    if provider not in {"cpu", "gpu"}:
        raise SettingsError("models.provider must be cpu or gpu")
    sam_model_type = models.get("sam_model_type")
    if sam_model_type not in {"vit_b", "vit_l", "vit_h"}:
        raise SettingsError("models.sam_model_type must be vit_b, vit_l, or vit_h")
    mode = detection.get("mode")
    if mode not in {"standard", "high_precision"}:
        raise SettingsError("detection.mode must be standard or high_precision")
    tool_position = display.get("tool_position")
    if tool_position not in {"left", "top", "right", "bottom"}:
        raise SettingsError("display.tool_position must be left, top, right, or bottom")
    paths = {}
    for key in ("target_segmentation", "hand_detection", "sam_checkpoint"):
        path = models.get(key)
        if not isinstance(path, str):
            raise SettingsError(f"models.{key} must be a string")
        paths[key] = path.strip()
    return {
        "general": {
            "language": language,
            "open_browser": _expect_bool(general.get("open_browser"), "general.open_browser"),
            "port": int(port),
            "shortcuts_enabled": _expect_bool(general.get("shortcuts_enabled"), "general.shortcuts_enabled"),
        },
        "models": {**paths, "sam_model_type": sam_model_type, "provider": provider},
        "display": {
            "apply_color": _expect_color(display.get("apply_color"), "display.apply_color"),
            "exclude_color": _expect_color(display.get("exclude_color"), "display.exclude_color"),
            "overlay_opacity": _expect_number(display.get("overlay_opacity"), "display.overlay_opacity", 0, 1),
            "mosaic_preview": _expect_bool(display.get("mosaic_preview"), "display.mosaic_preview"),
            "tool_position": tool_position,
        },
        "detection": {
            "mode": mode,
            "threshold": _expect_number(detection.get("threshold"), "detection.threshold", 0.1, 1),
            "parallelism": int(_expect_number(detection.get("parallelism"), "detection.parallelism", 1, 4)),
        },
    }
