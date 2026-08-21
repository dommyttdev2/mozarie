import json
import tempfile
import unittest
from unittest import mock
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mozarie.config import SettingsError, SettingsStore, validate_output_directory_ready, validate_settings


class SettingsTests(unittest.TestCase):
    def test_output_directory_ready_requires_an_existing_writable_directory_without_creating_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "保存先"
            with self.assertRaises(SettingsError):
                validate_output_directory_ready(target)
            self.assertFalse(target.exists())
            target.mkdir()
            self.assertEqual(validate_output_directory_ready(target), target.resolve())
            self.assertEqual(list(target.iterdir()), [])
            with self.assertRaises(SettingsError):
                validate_output_directory_ready(str(target) + "\x00bad")

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
            reset = store.reset()
            self.assertEqual(reset["general"], defaults["general"])
            self.assertEqual(reset["saving"]["default_output_directory"], str((root / "output").resolve()))
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

    def test_hand_segmentation_settings_merge_with_legacy_defaults(self):
        legacy = {
            "general": {"language": "ja", "open_browser": True, "port": 8766, "shortcuts_enabled": True},
            "models": {"target_segmentation": "", "ntd11": "", "ntd11_enabled": False, "sensitive": "", "sensitive_enabled": False, "hand_detection": "", "hand_detection_enabled": False, "sam_checkpoint": "", "sam_model_type": "vit_b", "provider": "gpu"},
            "display": {"apply_color": "#ff3d4d", "exclude_color": "#28d3ff", "overlay_opacity": 0.78, "mosaic_preview": True, "tool_position": "left"},
            "importing": {"parallelism": 3}, "detection": {"mode": "standard", "fluid_exclusion_enabled": True, "threshold": 0.5, "parallelism": 2},
        }
        settings = validate_settings(legacy)
        self.assertEqual(settings["models"]["hand_segmentation"], "")
        self.assertFalse(settings["models"]["hand_segmentation_enabled"])
        self.assertTrue(Path(settings["saving"]["default_output_directory"]).is_absolute())

    def test_output_directory_must_be_an_absolute_path(self):
        legacy = {
            "general": {"language": "ja", "open_browser": True, "port": 8766, "shortcuts_enabled": True},
            "models": {"target_segmentation": "", "ntd11": "", "ntd11_enabled": False, "sensitive": "", "sensitive_enabled": False, "hand_detection": "", "hand_detection_enabled": False, "sam_checkpoint": "", "sam_model_type": "vit_b", "provider": "gpu"},
            "display": {"apply_color": "#ff3d4d", "exclude_color": "#28d3ff", "overlay_opacity": 0.78, "mosaic_preview": True, "tool_position": "left"},
            "importing": {"parallelism": 3}, "detection": {"mode": "standard", "fluid_exclusion_enabled": True, "threshold": 0.5, "parallelism": 2},
            "saving": {"parallelism": 2, "default_output_directory": "relative-output"},
        }
        with self.assertRaises(SettingsError):
            validate_settings(legacy)
        legacy["saving"]["default_output_directory"] = "C:\\output\x00bad"
        with self.assertRaises(SettingsError):
            validate_settings(legacy)

    def test_legacy_shortcuts_gain_per_action_defaults(self):
        legacy = {
            "general": {"language": "ja", "open_browser": True, "port": 8766, "shortcuts_enabled": True},
            "models": {"target_segmentation": "", "ntd11": "", "ntd11_enabled": False, "sensitive": "", "sensitive_enabled": False, "hand_detection": "", "hand_detection_enabled": False, "sam_checkpoint": "", "sam_model_type": "vit_b", "provider": "gpu"},
            "display": {"apply_color": "#ff3d4d", "exclude_color": "#28d3ff", "overlay_opacity": 0.78, "mosaic_preview": True, "tool_position": "left"},
            "importing": {"parallelism": 3}, "detection": {"mode": "standard", "fluid_exclusion_enabled": True, "threshold": 0.5, "parallelism": 2},
        }
        settings = validate_settings(legacy)
        self.assertTrue(settings["shortcuts"]["actions"]["previousVisible"])
        self.assertEqual(settings["shortcuts"]["bindings"]["nextVisible"], "ArrowDown")
        self.assertTrue(settings["confirmations"]["candidateDelete"])

    def test_failed_atomic_replace_keeps_the_previous_local_json(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); config = root / "config"; config.mkdir()
            defaults = {
                "general": {"language": "ja", "open_browser": True, "port": 8766, "shortcuts_enabled": True},
                "models": {"target_segmentation": "", "ntd11": "", "ntd11_enabled": False, "sensitive": "", "sensitive_enabled": False, "hand_detection": "", "hand_detection_enabled": False, "sam_checkpoint": "", "sam_model_type": "vit_b", "provider": "gpu"},
                "display": {"apply_color": "#ff3d4d", "exclude_color": "#28d3ff", "overlay_opacity": 0.78, "mosaic_preview": True, "tool_position": "left"},
                "importing": {"parallelism": 3}, "detection": {"mode": "standard", "fluid_exclusion_enabled": True, "threshold": 0.5, "parallelism": 2},
            }
            (config / "defaults.json").write_text(json.dumps(defaults), encoding="utf-8")
            local = config / "local.json"; local.write_text('{"keep": true}', encoding="utf-8")
            store = SettingsStore(root)
            with mock.patch("mozarie.config.os.replace", side_effect=OSError("replace failed")):
                with self.assertRaises(OSError):
                    store.save({"general": {"language": "en"}})
            self.assertEqual(local.read_text(encoding="utf-8"), '{"keep": true}')
            self.assertEqual(list(config.glob(".local.json.*.tmp")), [])
