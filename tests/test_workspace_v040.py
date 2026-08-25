import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace

from mozarie.workspace import WorkspaceStore


class WorkspaceV040Tests(unittest.TestCase):
    def _image(self, root: Path):
        return SimpleNamespace(relative_path="001.png", size_bytes=10, mtime_ns=20)

    def test_manual_effective_presence_uses_scalar_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            store = WorkspaceStore(Path(directory))
            catalog = store.ensure_catalog()
            image_id = store.reconcile_images(catalog, [self._image(Path(directory))])["001.png"]["image_id"]
            store.save_manual(str(image_id), {"add": "x", "manualEnabled": True}, lambda value: b"\x89PNG\r\n\x1a\n" if value else None)
            self.assertEqual(store.manual_effective_mask_ids([str(image_id)]), {str(image_id)})

    def test_future_database_is_not_touched(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            with sqlite3.connect(store.path) as db:
                db.execute("UPDATE meta SET value=? WHERE key='schema_version'", (str(WorkspaceStore.VERSION + 1),))
            before = store.path.read_bytes()
            with self.assertRaisesRegex(RuntimeError, "newer"):
                WorkspaceStore(root)
            self.assertEqual(store.path.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
