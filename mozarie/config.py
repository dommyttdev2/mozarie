"""Tracked defaults and private per-machine Mozarie settings."""

from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any


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
        settings = _merge(self.load(), update)
        self.local_path.parent.mkdir(parents=True, exist_ok=True)
        self.local_path.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        return settings
