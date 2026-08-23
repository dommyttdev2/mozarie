"""Tracked defaults and private per-machine Mozarie settings."""

from __future__ import annotations

import copy
import json
import os
import re
import tempfile
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
        settings = defaults if not self.local_path.is_file() else _merge(defaults, json.loads(self.local_path.read_text(encoding="utf-8")))
        settings = self._normalise_sam_checkpoints(settings)
        return self._normalise_hand_segmentation(self._set_builtin_output_directory(settings))

    def save(self, update: dict[str, Any]) -> dict[str, Any]:
        return self.save_validated(self.validate_update(update))

    def validate_update(self, update: dict[str, Any]) -> dict[str, Any]:
        return validate_settings(_merge(self.load(), update))

    def default_settings(self) -> dict[str, Any]:
        defaults = json.loads(self.defaults_path.read_text(encoding="utf-8"))
        return validate_settings(self._set_builtin_output_directory(self._normalise_sam_checkpoints(defaults)))

    def _set_builtin_output_directory(self, settings: dict[str, Any]) -> dict[str, Any]:
        """Fill a missing built-in output setting and ensure that folder exists."""
        saving = settings.setdefault("saving", {})
        configured_directory = str(saving.get("default_output_directory", "")).strip()
        output_directory = (self.defaults_path.parent.parent / "output").resolve()
        try:
            uses_builtin_output = Path(configured_directory).is_absolute() and Path(configured_directory).resolve() == output_directory
        except (OSError, ValueError):
            uses_builtin_output = False
        if not configured_directory or uses_builtin_output:
            output_directory.mkdir(parents=True, exist_ok=True)
        if not configured_directory:
            saving["default_output_directory"] = str(output_directory.resolve())
        return settings

    @staticmethod
    def _normalise_hand_segmentation(settings: dict[str, Any]) -> dict[str, Any]:
        """Keep legacy settings usable when their HandSegNet parent is off."""
        models = settings.get("models")
        if isinstance(models, dict) and not models.get("hand_detection_enabled", False):
            models["hand_segmentation_enabled"] = False
        return settings

    @staticmethod
    def _normalise_sam_checkpoints(settings: dict[str, Any]) -> dict[str, Any]:
        """Migrate the former single SAM path into the selected variant slot."""
        models = settings.get("models")
        if not isinstance(models, dict):
            return settings
        selected = models.get("sam_model_type") if models.get("sam_model_type") in {"vit_b", "vit_l", "vit_h"} else "vit_b"
        raw = models.get("sam_checkpoints")
        checkpoints = {
            key: str(raw.get(key, "")).strip() if isinstance(raw, dict) else ""
            for key in ("vit_b", "vit_l", "vit_h")
        }
        legacy = str(models.get("sam_checkpoint", "")).strip()
        if legacy and not any(checkpoints.values()):
            match = re.search(r"(?:^|[_-])vit[_-]?([blh])(?:[_.-]|$)", Path(legacy).name, re.IGNORECASE)
            if match:
                selected = f"vit_{match.group(1).lower()}"
                models["sam_model_type"] = selected
            checkpoints[selected] = legacy
        models["sam_checkpoints"] = checkpoints
        models["sam_checkpoint"] = checkpoints[selected]
        return settings

    def save_validated(self, settings: dict[str, Any]) -> dict[str, Any]:
        self.local_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=self.local_path.parent, prefix=f".{self.local_path.name}.", suffix=".tmp", delete=False) as handle:
                temporary_path = Path(handle.name)
                persisted = copy.deepcopy(settings)
                persisted.get("models", {}).pop("sam_checkpoint", None)
                handle.write(json.dumps(persisted, ensure_ascii=False, indent=2) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, self.local_path)
            temporary_path = None
        finally:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
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
    importing = _expect_dict(settings.get("importing"), "importing")
    detection = _expect_dict(settings.get("detection"), "detection")
    saving = _expect_dict(settings.get("saving", {}), "saving")
    shortcuts = _expect_dict(settings.get("shortcuts", {}), "shortcuts")
    confirmations = _expect_dict(settings.get("confirmations", {}), "confirmations")
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
    fluid_exclusion_enabled = _expect_bool(
        detection.get("fluid_exclusion_enabled"), "detection.fluid_exclusion_enabled"
    )
    exclude_forced_default = _expect_bool(
        detection.get("exclude_forced_default", detection.get("force_exclusion_default", True)), "detection.exclude_forced_default"
    )
    tool_position = display.get("tool_position")
    if tool_position not in {"left", "top", "right", "bottom"}:
        raise SettingsError("display.tool_position must be left, top, right, or bottom")
    paths = {}
    for key in ("target_segmentation", "ntd11", "sensitive", "hand_detection", "hand_segmentation"):
        path = models.get(key, "") if key == "hand_segmentation" else models.get(key)
        if not isinstance(path, str):
            raise SettingsError(f"models.{key} must be a string")
        paths[key] = path.strip()
    raw_sam_checkpoints = _expect_dict(models.get("sam_checkpoints", {}), "models.sam_checkpoints")
    sam_checkpoints = {}
    for key in ("vit_b", "vit_l", "vit_h"):
        path = raw_sam_checkpoints.get(key, "")
        if not isinstance(path, str):
            raise SettingsError(f"models.sam_checkpoints.{key} must be a string")
        sam_checkpoints[key] = path.strip()
    legacy_sam = models.get("sam_checkpoint")
    if isinstance(legacy_sam, str) and legacy_sam.strip() and not any(sam_checkpoints.values()):
        sam_checkpoints[sam_model_type] = legacy_sam.strip()
    enabled = {
        key: _expect_bool(models.get(key, False) if key == "hand_segmentation_enabled" else models.get(key), f"models.{key}")
        for key in ("ntd11_enabled", "sensitive_enabled", "hand_detection_enabled", "hand_segmentation_enabled")
    }
    if enabled["hand_segmentation_enabled"] and not enabled["hand_detection_enabled"]:
        raise SettingsError("models.hand_segmentation_enabled requires models.hand_detection_enabled")
    return {
        "general": {
            "language": language,
            "open_browser": _expect_bool(general.get("open_browser"), "general.open_browser"),
            "port": int(port),
            "shortcuts_enabled": _expect_bool(general.get("shortcuts_enabled"), "general.shortcuts_enabled"),
        },
        "models": {
            **paths,
            **enabled,
            "sam_checkpoints": sam_checkpoints,
            "sam_checkpoint": sam_checkpoints[sam_model_type],
            "sam_model_type": sam_model_type,
            "provider": provider,
            "gpu_device": int(_expect_number(models.get("gpu_device", 0), "models.gpu_device", 0, 64)),
        },
        "display": {
            "apply_color": _expect_color(display.get("apply_color"), "display.apply_color"),
            "exclude_color": _expect_color(display.get("exclude_color"), "display.exclude_color"),
            "overlay_opacity": _expect_number(display.get("overlay_opacity"), "display.overlay_opacity", 0, 1),
            "mosaic_preview": _expect_bool(display.get("mosaic_preview"), "display.mosaic_preview"),
            "tool_position": tool_position,
        },
        "importing": {
            "parallelism": int(_expect_number(importing.get("parallelism"), "importing.parallelism", 1, 10)),
        },
        "detection": {
            "mode": mode,
            "fluid_exclusion_enabled": fluid_exclusion_enabled,
            "exclude_forced_default": exclude_forced_default,
            "threshold": _expect_number(detection.get("threshold"), "detection.threshold", 0.1, 1),
            "parallelism": int(_expect_number(detection.get("parallelism"), "detection.parallelism", 1, 4)),
            "targets": _validate_targets(detection.get("targets", ["penis", "pussy"])),
        },
        "saving": {
            "parallelism": int(_expect_number(saving.get("parallelism", 2), "saving.parallelism", 1, 8)),
            "default_output_directory": _validate_output_directory(
                saving.get("default_output_directory") or str((Path(__file__).resolve().parent.parent / "output").resolve())
            ),
        },
        "shortcuts": {
            "enabled": _expect_bool(shortcuts.get("enabled", general.get("shortcuts_enabled", True)), "shortcuts.enabled"),
            "bindings": _validate_shortcuts(shortcuts.get("bindings", _DEFAULT_SHORTCUTS)),
            "actions": _validate_shortcut_actions(shortcuts.get("actions", {})),
        },
        "confirmations": {
            key: _expect_bool(confirmations.get(key, True), f"confirmations.{key}")
            for key in ("clearMasks", "clearCatalog", "removeImage", "candidateDelete", "candidateRoleDelete", "overwriteSource", "deleteSourceAfterCopy")
        },
    }


def _validate_output_directory(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise SettingsError("saving.default_output_directory must be an absolute path")
    raw = value.strip()
    if "\x00" in raw:
        raise SettingsError("saving.default_output_directory must not contain NUL")
    path = Path(raw)
    if not path.is_absolute():
        raise SettingsError("saving.default_output_directory must be an absolute path")
    return str(path)


def validate_output_directory_ready(value: str | Path) -> Path:
    """Require an existing output folder; the actual save reports write errors."""
    raw = os.fspath(value)
    if "\x00" in raw:
        raise SettingsError("saving.default_output_directory must not contain NUL")
    path = Path(raw).expanduser()
    if not path.is_absolute() or not path.is_dir():
        raise SettingsError("saving.default_output_directory must be an existing directory")
    return path.resolve()


def _validate_targets(value: Any) -> list[str]:
    if not isinstance(value, list) or not value or any(item not in {"penis", "pussy"} for item in value):
        raise SettingsError("detection.targets must contain penis and/or pussy")
    return list(dict.fromkeys(value))


_DEFAULT_SHORTCUTS = {"previous": "ArrowLeft", "next": "ArrowRight", "previousVisible": "ArrowUp", "nextVisible": "ArrowDown", "first": "Home", "last": "End", "reviewAndNext": "Enter", "toggleOverview": "G", "undo": "Ctrl+Z", "redo": "Ctrl+Shift+Z"}
_SHORTCUT_ACTIONS = set(_DEFAULT_SHORTCUTS)


def _validate_shortcuts(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        raise SettingsError("shortcuts.bindings must be an object")
    bindings = {str(key): str(binding).strip() for key, binding in value.items() if key in _SHORTCUT_ACTIONS}
    if set(bindings) != _SHORTCUT_ACTIONS or not all(bindings.values()) or len(set(bindings.values())) != len(bindings):
        raise SettingsError("shortcut bindings must be complete and unique")
    return bindings


def _validate_shortcut_actions(value: Any) -> dict[str, bool]:
    if not isinstance(value, dict):
        raise SettingsError("shortcuts.actions must be an object")
    return {action: _expect_bool(value.get(action, True), f"shortcuts.actions.{action}") for action in _SHORTCUT_ACTIONS}
