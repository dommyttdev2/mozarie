import json
import tempfile
import unittest
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mozarie.config import SettingsError, SettingsStore, validate_settings


class SettingsTests(unittest.TestCase):
    def test_valid_settings_are_persisted_only_to_local_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "config").mkdir()
            defaults = {
                "general": {"language": "ja", "open_browser": True, "port": 8766, "shortcuts_enabled": True},
                "models": {"target_segmentation": "", "hand_detection": "", "sam_checkpoint": "", "sam_model_type": "vit_b", "provider": "gpu"},
                "display": {"apply_color": "#ff3d4d", "exclude_color": "#28d3ff", "overlay_opacity": 0.78, "mosaic_preview": True},
                "detection": {"mode": "standard", "threshold": 0.5, "parallelism": 2},
            }
            (root / "config" / "defaults.json").write_text(json.dumps(defaults), encoding="utf-8")
            store = SettingsStore(root)
            saved = store.save({"general": {"language": "en"}, "detection": {"mode": "high_precision", "parallelism": 4}})
            self.assertEqual(saved["general"]["language"], "en")
            self.assertEqual(saved["detection"]["mode"], "high_precision")
            self.assertTrue((root / "config" / "local.json").is_file())
            self.assertEqual(json.loads((root / "config" / "defaults.json").read_text(encoding="utf-8")), defaults)

    def test_reset_removes_only_machine_override(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / "config").mkdir()
            defaults = {
                "general": {"language": "ja", "open_browser": True, "port": 8766, "shortcuts_enabled": True},
                "models": {"target_segmentation": "", "hand_detection": "", "sam_checkpoint": "", "sam_model_type": "vit_b", "provider": "gpu"},
                "display": {"apply_color": "#ff3d4d", "exclude_color": "#28d3ff", "overlay_opacity": 0.78, "mosaic_preview": True},
                "detection": {"mode": "standard", "threshold": 0.5, "parallelism": 2},
            }
            (root / "config" / "defaults.json").write_text(json.dumps(defaults), encoding="utf-8")
            store = SettingsStore(root); store.save({"general": {"language": "en"}})
            self.assertTrue((root / "config" / "local.json").is_file())
            self.assertEqual(store.reset(), defaults)
            self.assertFalse((root / "config" / "local.json").exists())

    def test_invalid_provider_and_threshold_are_rejected(self):
        valid = {
            "general": {"language": "ja", "open_browser": True, "port": 8766, "shortcuts_enabled": True},
            "models": {"target_segmentation": "", "hand_detection": "", "sam_checkpoint": "", "sam_model_type": "vit_b", "provider": "gpu"},
            "display": {"apply_color": "#ff3d4d", "exclude_color": "#28d3ff", "overlay_opacity": 0.78, "mosaic_preview": True},
            "detection": {"mode": "standard", "threshold": 0.5, "parallelism": 2},
        }
        invalid_provider = json.loads(json.dumps(valid)); invalid_provider["models"]["provider"] = "metal"
        invalid_threshold = json.loads(json.dumps(valid)); invalid_threshold["detection"]["threshold"] = 1.1
        with self.assertRaises(SettingsError): validate_settings(invalid_provider)
        with self.assertRaises(SettingsError): validate_settings(invalid_threshold)
