from __future__ import annotations

import io
from pathlib import Path
import sys
import tempfile
import types
import unittest
from contextlib import redirect_stderr, redirect_stdout
from importlib import metadata
from types import SimpleNamespace
from unittest.mock import patch

from mozarie import migraphx_probe


class FakeArray:
    def __init__(self, value=64.0):
        self.value = value


class FakeNumpy:
    float32 = "float32"

    @staticmethod
    def ones(shape, dtype=None):
        if shape == (64, 64):
            return SimpleNamespace(reshape=lambda _shape: SimpleNamespace(tolist=lambda: [1.0] * (64 * 64)))
        return FakeArray(1.0)

    @staticmethod
    def asarray(value):
        return value

    @staticmethod
    def allclose(value, expected):
        return getattr(value, "value", value) == expected


class MigraphxProbeTests(unittest.TestCase):
    def test_validate_host(self) -> None:
        self.assertEqual(migraphx_probe.validate_host("win32", 26100), 26100)
        with self.assertRaisesRegex(migraphx_probe.ProbeError, "requires Windows"):
            migraphx_probe.validate_host("linux", 26100)
        with self.assertRaisesRegex(migraphx_probe.ProbeError, "24H2"):
            migraphx_probe.validate_host("win32", 26000)
        with patch.object(migraphx_probe.sys, "platform", "win32"), patch.object(
            migraphx_probe.sys, "getwindowsversion", return_value=SimpleNamespace(build=26200), create=True
        ):
            self.assertEqual(migraphx_probe.validate_host(), 26200)

    def test_runtime_distribution_validation(self) -> None:
        def version(name: str) -> str:
            if name == migraphx_probe.WINDOWSML_DISTRIBUTION:
                return "1.28"
            raise metadata.PackageNotFoundError

        self.assertEqual(
            migraphx_probe.installed_ort_distributions(version),
            {migraphx_probe.WINDOWSML_DISTRIBUTION: "1.28"},
        )
        with patch.object(
            migraphx_probe,
            "installed_ort_distributions",
            return_value={migraphx_probe.WINDOWSML_DISTRIBUTION: "1.28"},
        ):
            self.assertEqual(
                migraphx_probe.validate_runtime_install(),
                {migraphx_probe.WINDOWSML_DISTRIBUTION: "1.28"},
            )
        with self.assertRaisesRegex(migraphx_probe.ProbeError, "not installed"):
            migraphx_probe.validate_runtime_install({})
        with self.assertRaisesRegex(migraphx_probe.ProbeError, "conflicting"):
            migraphx_probe.validate_runtime_install(
                {
                    migraphx_probe.WINDOWSML_DISTRIBUTION: "1.28",
                    "onnxruntime-directml": "1.24",
                }
            )

    def test_repair_winrt_runtime(self) -> None:
        with self.assertRaisesRegex(migraphx_probe.ProbeError, "winrt-runtime"):
            migraphx_probe.repair_winrt_runtime(lambda _name: (_ for _ in ()).throw(metadata.PackageNotFoundError()))
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "winrt").mkdir()
            dist = SimpleNamespace(locate_file=lambda _value: root)
            self.assertFalse(migraphx_probe.repair_winrt_runtime(lambda _name: dist))
            dll = root / "winrt" / "msvcp140.dll"
            dll.write_bytes(b"x")
            self.assertTrue(migraphx_probe.repair_winrt_runtime(lambda _name: dist))
            self.assertFalse(dll.exists())
            dll.mkdir()
            with self.assertRaisesRegex(migraphx_probe.ProbeError, "Could not remove"):
                migraphx_probe.repair_winrt_runtime(lambda _name: dist)

    def test_ensure_migraphx_provider(self) -> None:
        success = object()
        winml = SimpleNamespace(ExecutionProviderReadyResultState=SimpleNamespace(SUCCESS=success))
        good = SimpleNamespace(
            name=migraphx_probe.EP_NAME,
            ready_state="Ready",
            library_path="ep.dll",
            ensure_ready_async=lambda: SimpleNamespace(get=lambda: SimpleNamespace(status=success)),
        )
        other = SimpleNamespace(name="OtherEP", ready_state="Ready", library_path="other.dll")
        winml.ExecutionProviderCatalog = SimpleNamespace(
            get_default=lambda: SimpleNamespace(find_all_providers=lambda: [other, good])
        )
        selected, inventory = migraphx_probe.ensure_migraphx_provider(winml)
        self.assertIs(selected, good)
        self.assertEqual(inventory[0]["name"], "OtherEP")

        winml.ExecutionProviderCatalog = SimpleNamespace(
            get_default=lambda: SimpleNamespace(find_all_providers=lambda: [other])
        )
        with self.assertRaisesRegex(migraphx_probe.ProbeError, "not available"):
            migraphx_probe.ensure_migraphx_provider(winml)

        failed = SimpleNamespace(
            name=migraphx_probe.EP_NAME,
            ready_state="NotPresent",
            library_path="",
            ensure_ready_async=lambda: SimpleNamespace(
                get=lambda: SimpleNamespace(status=object(), diagnostic_text="diag", extended_error="hr")
            ),
        )
        winml.ExecutionProviderCatalog = SimpleNamespace(
            get_default=lambda: SimpleNamespace(find_all_providers=lambda: [failed])
        )
        with self.assertRaisesRegex(migraphx_probe.ProbeError, "diag; hr"):
            migraphx_probe.ensure_migraphx_provider(winml)

        failed.ensure_ready_async = lambda: SimpleNamespace(
            get=lambda: SimpleNamespace(status=object(), diagnostic_text="", extended_error="")
        )
        with self.assertRaisesRegex(migraphx_probe.ProbeError, r"prepare .+\."):
            migraphx_probe.ensure_migraphx_provider(winml)

        no_path = SimpleNamespace(
            name=migraphx_probe.EP_NAME,
            ready_state="Ready",
            library_path="",
            ensure_ready_async=lambda: SimpleNamespace(get=lambda: SimpleNamespace(status=success)),
        )
        winml.ExecutionProviderCatalog = SimpleNamespace(
            get_default=lambda: SimpleNamespace(find_all_providers=lambda: [no_path])
        )
        with self.assertRaisesRegex(migraphx_probe.ProbeError, "no plugin library path"):
            migraphx_probe.ensure_migraphx_provider(winml)

    def test_device_description_and_selection(self) -> None:
        device = SimpleNamespace(ep_name=migraphx_probe.EP_NAME, ep_vendor="AMD", device="GPU")
        self.assertEqual(migraphx_probe.describe_ep_device(device, 3)["index"], 3)
        ort = SimpleNamespace(get_ep_devices=lambda: [device])
        selected, inventory = migraphx_probe.select_migraphx_device(ort)
        self.assertIs(selected, device)
        self.assertEqual(inventory[0]["epVendor"], "AMD")
        with self.assertRaisesRegex(migraphx_probe.ProbeError, "no MIGraphX"):
            migraphx_probe.select_migraphx_device(SimpleNamespace(get_ep_devices=lambda: []))
        two = SimpleNamespace(get_ep_devices=lambda: [device, device])
        with self.assertRaisesRegex(migraphx_probe.ProbeError, "2 MIGraphX"):
            migraphx_probe.select_migraphx_device(two)
        self.assertIs(migraphx_probe.select_migraphx_device(two, 1)[0], device)
        for index in (-1, 2):
            with self.subTest(index=index), self.assertRaisesRegex(migraphx_probe.ProbeError, "unavailable"):
                migraphx_probe.select_migraphx_device(two, index)

    def test_build_model_and_run_inference(self) -> None:
        helper = SimpleNamespace(
            make_tensor_value_info=lambda *_args: object(),
            make_tensor=lambda *_args, **_kwargs: object(),
            make_node=lambda *_args: object(),
            make_graph=lambda *_args: object(),
            make_opsetid=lambda *_args: object(),
            make_model=lambda *_args, **_kwargs: SimpleNamespace(SerializeToString=lambda: b"model"),
        )
        onnx = SimpleNamespace(helper=helper, TensorProto=SimpleNamespace(FLOAT=1))
        self.assertEqual(migraphx_probe.build_matmul_model(onnx, FakeNumpy), b"model")

        class Options:
            def __init__(self):
                self.graph_optimization_level = None
                self.devices = None
            def add_provider_for_devices(self, devices, options):
                self.devices = (devices, options)

        disabled = []
        session = SimpleNamespace(
            disable_fallback=lambda: disabled.append(True),
            get_providers=lambda: [migraphx_probe.EP_NAME],
            run=lambda *_args: [FakeArray(64.0)],
        )
        ort = SimpleNamespace(
            SessionOptions=Options,
            GraphOptimizationLevel=SimpleNamespace(ORT_ENABLE_ALL="all"),
            InferenceSession=lambda *_args, **_kwargs: session,
        )
        result = migraphx_probe.run_migraphx_inference(ort, onnx, FakeNumpy, object())
        self.assertTrue(disabled)
        self.assertTrue(result["outputVerified"])

        session.disable_fallback = None
        session.get_providers = lambda: []
        with self.assertRaisesRegex(migraphx_probe.ProbeError, "did not select"):
            migraphx_probe.run_migraphx_inference(ort, onnx, FakeNumpy, object())
        session.get_providers = lambda: [migraphx_probe.EP_NAME]
        session.run = lambda *_args: []
        with self.assertRaisesRegex(migraphx_probe.ProbeError, "unexpected"):
            migraphx_probe.run_migraphx_inference(ort, onnx, FakeNumpy, object())
        session.run = lambda *_args: [FakeArray(0.0)]
        with self.assertRaisesRegex(migraphx_probe.ProbeError, "unexpected"):
            migraphx_probe.run_migraphx_inference(ort, onnx, FakeNumpy, object())

    @staticmethod
    def _fake_winml_modules() -> tuple[dict[str, types.ModuleType], object, object]:
        bootstrap = types.ModuleType("winui3.microsoft.windows.applicationmodel.dynamicdependency.bootstrap")
        class Handle:
            def __enter__(self):
                return self
            def __exit__(self, *_args):
                return None
        handle = Handle()
        bootstrap.InitializeOptions = SimpleNamespace(ON_NO_MATCH_SHOW_UI="show")
        bootstrap.initialize = lambda **_kwargs: handle
        winml = types.ModuleType("winui3.microsoft.windows.ai.machinelearning")
        np_module = types.ModuleType("numpy")
        onnx_module = types.ModuleType("onnx")
        ort_module = types.ModuleType("onnxruntime")
        modules = {
            "winui3": types.ModuleType("winui3"),
            "winui3.microsoft": types.ModuleType("winui3.microsoft"),
            "winui3.microsoft.windows": types.ModuleType("winui3.microsoft.windows"),
            "winui3.microsoft.windows.applicationmodel": types.ModuleType("winui3.microsoft.windows.applicationmodel"),
            "winui3.microsoft.windows.applicationmodel.dynamicdependency": types.ModuleType("winui3.microsoft.windows.applicationmodel.dynamicdependency"),
            "winui3.microsoft.windows.applicationmodel.dynamicdependency.bootstrap": bootstrap,
            "winui3.microsoft.windows.ai": types.ModuleType("winui3.microsoft.windows.ai"),
            "winui3.microsoft.windows.ai.machinelearning": winml,
            "numpy": np_module,
            "onnx": onnx_module,
            "onnxruntime": ort_module,
        }
        return modules, winml, ort_module

    def test_probe_success_and_registration_failure(self) -> None:
        modules, winml, ort = self._fake_winml_modules()
        provider = SimpleNamespace(name=migraphx_probe.EP_NAME, library_path="ep.dll")
        ort.register_execution_provider_library = lambda *_args: None
        with patch.object(migraphx_probe, "validate_host", return_value=26100), \
                patch.object(migraphx_probe, "validate_runtime_install", return_value={"x": "1"}), \
                patch.object(migraphx_probe, "repair_winrt_runtime", return_value=True), \
                patch.object(migraphx_probe, "ensure_migraphx_provider", return_value=(provider, [{"name": "m"}])), \
                patch.object(migraphx_probe, "select_migraphx_device", return_value=(object(), [{"index": 0}])), \
                patch.object(migraphx_probe, "run_migraphx_inference", return_value={"providers": [migraphx_probe.EP_NAME], "outputVerified": True}), \
                patch.dict(sys.modules, modules):
            result = migraphx_probe.probe(0)
        self.assertEqual(result["status"], "ok")
        self.assertTrue(result["winrtRuntimeDllRemoved"])

        ort.register_execution_provider_library = lambda *_args: (_ for _ in ()).throw(RuntimeError("bad register"))
        with patch.object(migraphx_probe, "validate_host", return_value=26100), \
                patch.object(migraphx_probe, "validate_runtime_install", return_value={}), \
                patch.object(migraphx_probe, "repair_winrt_runtime", return_value=False), \
                patch.object(migraphx_probe, "ensure_migraphx_provider", return_value=(provider, [])), \
                patch.dict(sys.modules, modules):
            with self.assertRaisesRegex(migraphx_probe.ProbeError, "bad register"):
                migraphx_probe.probe()

    def test_probe_dependency_import_failure(self) -> None:
        original_import = __import__
        def fake_import(name, *args, **kwargs):
            if name.startswith("winui3"):
                raise ImportError("missing winml")
            return original_import(name, *args, **kwargs)
        with patch.object(migraphx_probe, "validate_host", return_value=26100), \
                patch.object(migraphx_probe, "validate_runtime_install", return_value={}), \
                patch.object(migraphx_probe, "repair_winrt_runtime", return_value=False), \
                patch("builtins.__import__", side_effect=fake_import):
            with self.assertRaisesRegex(migraphx_probe.ProbeError, "missing winml"):
                migraphx_probe.probe()

    def test_main_success_and_failure(self) -> None:
        stdout = io.StringIO()
        with patch.object(sys, "argv", ["migraphx_probe", "--ep-device-index", "1"]), \
                patch.object(migraphx_probe, "probe", return_value={"status": "ok"}) as probe, redirect_stdout(stdout):
            self.assertEqual(migraphx_probe.main(), 0)
        probe.assert_called_once_with(1)
        self.assertIn('"status": "ok"', stdout.getvalue())

        stderr = io.StringIO()
        with patch.object(sys, "argv", ["migraphx_probe"]), \
                patch.object(migraphx_probe, "probe", side_effect=migraphx_probe.ProbeError("boom")), redirect_stderr(stderr):
            self.assertEqual(migraphx_probe.main(), 1)
        self.assertIn("boom", stderr.getvalue())


if __name__ == "__main__":
    unittest.main()
