"""Regression coverage for persisted filesystem path contracts."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from mozarie.config import SettingsError, SettingsStore, validate_settings


class AbsolutePathRegressionTests(unittest.TestCase):
    def test_relative_model_and_output_paths_are_rejected_for_new_settings(self) -> None:
        defaults = json.loads((Path(__file__).parents[1] / "config" / "defaults.json").read_text(encoding="utf-8"))
        defaults["models"]["target_segmentation"] = "models/target.onnx"
        defaults["saving"]["default_output_directory"] = "output"
        with self.assertRaises(SettingsError):
            validate_settings(defaults)

    def test_legacy_relative_paths_are_migrated_to_absolute_paths_once(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            config = root / "app" / "config"
            config.mkdir(parents=True)
            defaults_path = config / "defaults.json"
            local_path = config / "local.json"
            defaults = json.loads((Path(__file__).parents[1] / "config" / "defaults.json").read_text(encoding="utf-8"))
            defaults_path.write_text(json.dumps(defaults), encoding="utf-8")
            local_path.write_text(json.dumps({"models": {"target_segmentation": "models/target.onnx"}, "saving": {"default_output_directory": "output"}}), encoding="utf-8")
            settings = SettingsStore(root / "app").load()
            self.assertTrue(Path(settings["models"]["target_segmentation"]).is_absolute())
            self.assertTrue(Path(settings["saving"]["default_output_directory"]).is_absolute())
            persisted = json.loads(local_path.read_text(encoding="utf-8"))
            self.assertTrue(Path(persisted["models"]["target_segmentation"]).is_absolute())


if __name__ == "__main__":
    unittest.main()
