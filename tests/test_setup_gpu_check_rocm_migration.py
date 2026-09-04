from __future__ import annotations

import contextlib
import io
import sys
import types
import unittest
from unittest.mock import Mock, patch

import setup_gpu_check


def _torch(*, count: int, names: tuple[str, ...] | None = None, hip: str | None = "7.13", available: bool = True):
    resolved_names = names or tuple(f"GPU {index}" for index in range(count))
    return types.SimpleNamespace(
        version=types.SimpleNamespace(hip=hip),
        cuda=types.SimpleNamespace(
            is_available=lambda: available,
            device_count=lambda: count,
            get_device_name=lambda index: resolved_names[index],
        ),
    )


class RocmSetupDeviceMigrationTests(unittest.TestCase):
    def test_valid_rocm_device_is_preserved(self) -> None:
        with patch.dict(sys.modules, {"torch": _torch(count=2, names=("GPU A", "GPU B"))}):
            self.assertEqual(
                setup_gpu_check._resolve_rocm_setup_device(1),
                (1, "GPU B", False),
            )

    def test_invalid_saved_device_migrates_only_when_rocm_device_is_unique(self) -> None:
        with patch.dict(sys.modules, {"torch": _torch(count=1, names=("AMD Radeon RX 6600M",))}):
            self.assertEqual(
                setup_gpu_check._resolve_rocm_setup_device(1),
                (0, "AMD Radeon RX 6600M", True),
            )

    def test_rocm_device_resolution_rejects_unavailable_runtime(self) -> None:
        with patch.dict(sys.modules, {"torch": _torch(count=1, hip=None)}):
            with self.assertRaisesRegex(RuntimeError, "ROCm/HIP"):
                setup_gpu_check._resolve_rocm_setup_device(0)
        with patch.dict(sys.modules, {"torch": _torch(count=1, available=False)}):
            with self.assertRaisesRegex(RuntimeError, "usable HIP"):
                setup_gpu_check._resolve_rocm_setup_device(0)
        with patch.dict(sys.modules, {"torch": _torch(count=0)}):
            with self.assertRaisesRegex(RuntimeError, "did not find"):
                setup_gpu_check._resolve_rocm_setup_device(0)

    def test_invalid_saved_device_fails_closed_when_multiple_rocm_devices_exist(self) -> None:
        with patch.dict(sys.modules, {"torch": _torch(count=2)}):
            with self.assertRaisesRegex(RuntimeError, "ambiguous"):
                setup_gpu_check._resolve_rocm_setup_device(3)

    def test_setup_migrates_unique_rocm_device_after_validation(self) -> None:
        store = types.SimpleNamespace(
            load=Mock(return_value={"models": {"gpu_device": 1}}),
            save=Mock(),
        )
        output = io.StringIO()
        with patch.object(setup_gpu_check, "SettingsStore", return_value=store), \
             patch.object(setup_gpu_check, "selected_profile", return_value="rocm"), \
             patch.object(
                 setup_gpu_check,
                 "_resolve_rocm_setup_device",
                 return_value=(0, "AMD Radeon RX 6600M", True),
             ), \
             patch.object(setup_gpu_check, "validate") as validate, \
             contextlib.redirect_stdout(output):
            self.assertEqual(setup_gpu_check.main(), 0)

        validate.assert_called_once_with("rocm", 0)
        store.save.assert_called_once_with({"models": {"gpu_device": 0}})
        self.assertIn(
            "ROCm GPU selection migrated from logical GPU 1 to 0 (AMD Radeon RX 6600M)",
            output.getvalue(),
        )
        self.assertIn("ROCm/DirectML GPU 0 is ready", output.getvalue())

    def test_setup_does_not_change_a_valid_rocm_device(self) -> None:
        store = types.SimpleNamespace(
            load=Mock(return_value={"models": {"gpu_device": 0}}),
            save=Mock(),
        )
        with patch.object(setup_gpu_check, "SettingsStore", return_value=store), \
             patch.object(setup_gpu_check, "selected_profile", return_value="rocm"), \
             patch.object(
                 setup_gpu_check,
                 "_resolve_rocm_setup_device",
                 return_value=(0, "AMD Radeon RX 6600M", False),
             ), \
             patch.object(setup_gpu_check, "validate") as validate:
            self.assertEqual(setup_gpu_check.main(), 0)

        validate.assert_called_once_with("rocm", 0)
        store.save.assert_not_called()

    def test_setup_stops_if_migrated_rocm_device_cannot_be_saved(self) -> None:
        store = types.SimpleNamespace(
            load=Mock(return_value={"models": {"gpu_device": 1}}),
            save=Mock(side_effect=OSError("locked")),
        )
        output = io.StringIO()
        with patch.object(setup_gpu_check, "SettingsStore", return_value=store), \
             patch.object(setup_gpu_check, "selected_profile", return_value="rocm"), \
             patch.object(
                 setup_gpu_check,
                 "_resolve_rocm_setup_device",
                 return_value=(0, "AMD Radeon RX 6600M", True),
             ), \
             patch.object(setup_gpu_check, "validate"), \
             contextlib.redirect_stdout(output):
            self.assertEqual(setup_gpu_check.main(), 1)

        self.assertIn("could not be saved", output.getvalue())
        self.assertIn(setup_gpu_check.ROCM_DEVICE_SAVE_FAILED_MESSAGE, output.getvalue())

    def test_setup_keeps_fail_closed_behavior_when_rocm_selection_is_ambiguous(self) -> None:
        store = types.SimpleNamespace(
            load=Mock(return_value={"models": {"gpu_device": 3}}),
            save=Mock(),
        )
        output = io.StringIO()
        with patch.object(setup_gpu_check, "SettingsStore", return_value=store), \
             patch.object(setup_gpu_check, "selected_profile", return_value="rocm"), \
             patch.object(
                 setup_gpu_check,
                 "_resolve_rocm_setup_device",
                 side_effect=RuntimeError("replacement device is ambiguous"),
             ), \
             patch.object(setup_gpu_check, "validate") as validate, \
             contextlib.redirect_stdout(output):
            self.assertEqual(setup_gpu_check.main(), 1)

        validate.assert_not_called()
        store.save.assert_not_called()
        self.assertIn("ambiguous", output.getvalue())


if __name__ == "__main__":
    unittest.main()
