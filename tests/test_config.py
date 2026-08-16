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
                "models": {"target_segmentation": "", "ntd11": "", "ntd11_enabled": False, "sensitive": "", "sensitive_enabled": False, "hand_detection": "", "hand_detection_enabled": False, "sam_checkpoint": "", "sam_model_type": "vit_b", "provider": "gpu"},
                "display": {"apply_color": "#ff3d4d", "exclude_color": "#28d3ff", "overlay_opacity": 0.78, "mosaic_preview": True, "tool_position": "left"},
                "importing": {"parallelism": 3},
                "detection": {"mode": "standard", "fluid_exclusion_enabled": True, "threshold": 0.5, "parallelism": 2},
            }
            (root / "config" / "defaults.json").write_text(json.dumps(defaults), encoding="utf-8")
            store = SettingsStore(root)
            saved = store.save({"general": {"language": "en"}, "display": {"tool_position": "bottom"}, "importing": {"parallelism": 10}, "detection": {"mode": "high_precision", "parallelism": 4}})
            self.assertEqual(saved["general"]["language"], "en")
            self.assertEqual(saved["display"]["tool_position"], "bottom")
            self.assertEqual(saved["detection"]["mode"], "high_precision")
            self.assertTrue(saved["detection"]["fluid_exclusion_enabled"])
            self.assertEqual(saved["importing"]["parallelism"], 10)
            self.assertTrue((root / "config" / "local.json").is_file())
            self.assertEqual(json.loads((root / "config" / "defaults.json").read_text(encoding="utf-8")), defaults)

    def test_reset_removes_only_machine_override(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); (root / "config").mkdir()
            defaults = {
                "general": {"language": "ja", "open_browser": True, "port": 8766, "shortcuts_enabled": True},
                "models": {"target_segmentation": "", "ntd11": "", "ntd11_enabled": False, "sensitive": "", "sensitive_enabled": False, "hand_detection": "", "hand_detection_enabled": False, "sam_checkpoint": "", "sam_model_type": "vit_b", "provider": "gpu"},
                "display": {"apply_color": "#ff3d4d", "exclude_color": "#28d3ff", "overlay_opacity": 0.78, "mosaic_preview": True, "tool_position": "left"},
                "importing": {"parallelism": 3},
                "detection": {"mode": "standard", "fluid_exclusion_enabled": True, "threshold": 0.5, "parallelism": 2},
            }
            (root / "config" / "defaults.json").write_text(json.dumps(defaults), encoding="utf-8")
            store = SettingsStore(root); store.save({"general": {"language": "en"}})
            self.assertTrue((root / "config" / "local.json").is_file())
            self.assertEqual(store.reset(), defaults)
            self.assertFalse((root / "config" / "local.json").exists())

    def test_invalid_provider_and_threshold_are_rejected(self):
        valid = {
            "general": {"language": "ja", "open_browser": True, "port": 8766, "shortcuts_enabled": True},
            "models": {"target_segmentation": "", "ntd11": "", "ntd11_enabled": False, "sensitive": "", "sensitive_enabled": False, "hand_detection": "", "hand_detection_enabled": False, "sam_checkpoint": "", "sam_model_type": "vit_b", "provider": "gpu"},
            "display": {"apply_color": "#ff3d4d", "exclude_color": "#28d3ff", "overlay_opacity": 0.78, "mosaic_preview": True, "tool_position": "left"},
            "importing": {"parallelism": 3},
            "detection": {"mode": "standard", "fluid_exclusion_enabled": True, "threshold": 0.5, "parallelism": 2},
        }
        invalid_provider = json.loads(json.dumps(valid)); invalid_provider["models"]["provider"] = "metal"
        invalid_threshold = json.loads(json.dumps(valid)); invalid_threshold["detection"]["threshold"] = 1.1
        invalid_tool_position = json.loads(json.dumps(valid)); invalid_tool_position["display"]["tool_position"] = "center"
        invalid_fluid_exclusion = json.loads(json.dumps(valid)); invalid_fluid_exclusion["detection"]["fluid_exclusion_enabled"] = "yes"
        invalid_import_parallelism = json.loads(json.dumps(valid)); invalid_import_parallelism["importing"]["parallelism"] = 11
        with self.assertRaises(SettingsError): validate_settings(invalid_provider)
        with self.assertRaises(SettingsError): validate_settings(invalid_threshold)
        with self.assertRaises(SettingsError): validate_settings(invalid_tool_position)
        with self.assertRaises(SettingsError): validate_settings(invalid_fluid_exclusion)
        with self.assertRaises(SettingsError): validate_settings(invalid_import_parallelism)
