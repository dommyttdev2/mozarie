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
            store.save_manual(str(image_id), {"add": "x", "manualEnabled": True, "hasEffectiveMask": True}, lambda value: b"\x89PNG\r\n\x1a\n" if value else None)
            self.assertEqual(store.manual_effective_masks([str(image_id)]), {str(image_id): True})

    def test_manual_effective_mask_requires_the_client_scalar(self):
        with tempfile.TemporaryDirectory() as directory:
            store = WorkspaceStore(Path(directory))
            catalog = store.ensure_catalog()
            image_id = str(store.reconcile_images(catalog, [self._image(Path(directory))])["001.png"]["image_id"])
            with self.assertRaisesRegex(ValueError, "effective mask"):
                store.save_manual(image_id, {"add": "x"}, lambda value: b"png" if value else None)

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

    def test_invalid_schema_version_is_rejected_without_mutation(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            with sqlite3.connect(store.path) as db:
                db.execute("UPDATE meta SET value=? WHERE key='schema_version'", ("not-a-version",))
            before = store.path.read_bytes()
            with self.assertRaisesRegex(RuntimeError, "recreated"):
                WorkspaceStore(root)
            self.assertEqual(store.path.read_bytes(), before)

    def test_empty_candidate_set_keeps_nonzero_revision_after_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            store = WorkspaceStore(Path(directory))
            catalog = store.ensure_catalog()
            image_id = str(store.reconcile_images(catalog, [self._image(Path(directory))])["001.png"]["image_id"])
            store.replace_candidates(image_id, 7, [])
            reopened = WorkspaceStore(Path(directory))
            restored = reopened.reconcile_images(catalog, [self._image(Path(directory))])
            self.assertEqual(restored["001.png"]["revision"], 7)


if __name__ == "__main__":
    unittest.main()
