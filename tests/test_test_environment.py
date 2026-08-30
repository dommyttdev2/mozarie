from __future__ import annotations

import unittest
from pathlib import Path

from tests import TEST_APP_DIR
from mozarie import core, state


class TestEnvironmentTests(unittest.TestCase):
    def test_import_time_state_uses_the_disposable_test_app_directory(self) -> None:
        source_root = Path(__file__).resolve().parents[1]
        self.assertNotEqual(TEST_APP_DIR, source_root)
        self.assertEqual(core.APP_DIR, TEST_APP_DIR)
        self.assertEqual(state.APP_DIR, TEST_APP_DIR)
        self.assertIsNotNone(state.STATE)
        assert state.STATE is not None
        self.assertEqual(state.STATE.settings_store.defaults_path, TEST_APP_DIR / "config" / "defaults.json")
        self.assertEqual(state.STATE.workspace_store.path, TEST_APP_DIR / "data" / "workspaces.sqlite3")
        self.assertTrue((TEST_APP_DIR / "output").is_dir())
        self.assertTrue(state.STATE.workspace_store.path.is_file())


if __name__ == "__main__":
    unittest.main()
