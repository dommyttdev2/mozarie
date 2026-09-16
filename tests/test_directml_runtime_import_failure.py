from __future__ import annotations

import builtins
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from mozarie import runtime as runtime_module


class DirectMlIdentityResolverImportFailureTests(unittest.TestCase):
    def test_default_physical_identity_resolver_import_failure_fails_closed(self) -> None:
        directml = SimpleNamespace(device_count=lambda: 1, device_name=lambda index: "GPU 0")
        adapters = [
            runtime_module.DxgiDevice(index=0, name="GPU 0", luid=(1, 10)),
            runtime_module.DxgiDevice(index=2, name="GPU 0", luid=(1, 20)),
        ]
        original_import = builtins.__import__

        def failing_import(name, globals=None, locals=None, fromlist=(), level=0):
            if level == 1 and name == "directml_identity":
                raise ImportError("DirectML identity resolver unavailable")
            return original_import(name, globals, locals, fromlist, level)

        with patch("builtins.__import__", side_effect=failing_import):
            with self.assertRaisesRegex(
                RuntimeError,
                "Unable to map the selected DirectML GPU to one physical DXGI adapter",
            ):
                runtime_module.directml_onnx_device_id(
                    0,
                    module=directml,
                    adapters=adapters,
                )


if __name__ == "__main__":
    unittest.main()
