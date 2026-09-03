from __future__ import annotations

import unittest

from mozarie import rocm_directml_probe as probe
from mozarie.runtime import DxgiDevice


class RocmDirectmlAliasIdentityTests(unittest.TestCase):
    def test_duplicate_dxgi_names_are_accepted_only_when_physical_identity_matches(self) -> None:
        adapters = [
            DxgiDevice(0, "AMD Radeon RX 6600M", (0, 52342)),
            DxgiDevice(2, "AMD Radeon RX 6600M", (0, 26920747)),
        ]
        identity = frozenset({("pci\\ven_1002&dev_73ff", "driver\\rx6600m")})

        index, inventory = probe.select_directml_adapter(
            "AMD Radeon RX 6600M",
            adapters,
            physical_identity_resolver=lambda _luid: identity,
        )

        self.assertEqual(index, 0)
        self.assertEqual([item["index"] for item in inventory], [0, 2])

    def test_duplicate_dxgi_names_still_fail_closed_when_identity_differs(self) -> None:
        adapters = [
            DxgiDevice(0, "AMD Radeon RX 6600M", (0, 52342)),
            DxgiDevice(2, "AMD Radeon RX 6600M", (0, 26920747)),
        ]

        with self.assertRaisesRegex(probe.rocm_probe.ProbeError, "multiple DXGI"):
            probe.select_directml_adapter(
                "AMD Radeon RX 6600M",
                adapters,
                physical_identity_resolver=lambda luid: frozenset({(str(luid), "different")}),
            )

    def test_duplicate_dxgi_names_still_fail_closed_when_identity_is_unavailable(self) -> None:
        adapters = [
            DxgiDevice(0, "AMD Radeon RX 6600M", (0, 52342)),
            DxgiDevice(2, "AMD Radeon RX 6600M", (0, 26920747)),
        ]

        with self.assertRaisesRegex(probe.rocm_probe.ProbeError, "multiple DXGI"):
            probe.select_directml_adapter(
                "AMD Radeon RX 6600M",
                adapters,
                physical_identity_resolver=lambda _luid: None,
            )


if __name__ == "__main__":
    unittest.main()
