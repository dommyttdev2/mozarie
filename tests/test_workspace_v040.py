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
            connection = sqlite3.connect(store.path)
            with connection as db:
                db.execute("UPDATE meta SET value=? WHERE key='schema_version'", (str(WorkspaceStore.VERSION + 1),))
            connection.close()
            before = store.path.read_bytes()
            with self.assertRaisesRegex(RuntimeError, "newer"):
                WorkspaceStore(root)
            self.assertEqual(store.path.read_bytes(), before)

    def test_invalid_schema_version_is_rejected_without_mutation(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            connection = sqlite3.connect(store.path)
            with connection as db:
                db.execute("UPDATE meta SET value=? WHERE key='schema_version'", ("not-a-version",))
            connection.close()
            before = store.path.read_bytes()
            with self.assertRaisesRegex(RuntimeError, "recreated"):
                WorkspaceStore(root)
            self.assertEqual(store.path.read_bytes(), before)

    def test_v1_and_missing_schema_versions_are_rejected_without_mutation(self):
        for version in ("1", None):
            with self.subTest(version=version), tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
                root = Path(directory)
                store = WorkspaceStore(root)
                connection = sqlite3.connect(store.path)
                with connection as db:
                    if version is None:
                        db.execute("DELETE FROM meta WHERE key='schema_version'")
                    else:
                        db.execute("UPDATE meta SET value=? WHERE key='schema_version'", (version,))
                connection.close()
                before = store.path.read_bytes()
                with self.assertRaisesRegex(RuntimeError, "recreated|not a Mozarie"):
                    WorkspaceStore(root)
                self.assertEqual(store.path.read_bytes(), before)

    def test_v2_database_migrates_without_losing_workspace_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            catalog = store.ensure_catalog("a" * 32)
            image_id = str(store.reconcile_images(catalog, [self._image(root)])["001.png"]["image_id"])
            connection = sqlite3.connect(store.path)
            with connection as db:
                db.execute("UPDATE images SET hidden=1,reviewed=1,candidate_revision=42 WHERE image_id=?", (image_id,))
                db.execute("""INSERT INTO candidates(
                    image_id,candidate_id,class_name,confidence,mask_png,enabled,color,source,origin,
                    refinement,role,forced,deleted
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                    image_id, "candidate", "person", 0.9, b"candidate-mask", 1, "#123456", "detector",
                    "automatic", "refined", "apply", 0, 0,
                ))
                db.execute("""INSERT INTO manual_edits(
                    image_id,add_png,exclusion_png,exclusion_erase_png,manual_enabled,exclusion_enabled,
                    exclusion_erase_enabled,exclusion_forced,removed_candidate_ids,candidate_revision,updated_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?)""", (
                    image_id, b"add-mask", b"exclude-mask", b"erase-mask", 0, 1, 0, 1,
                    '["candidate"]', 42, 123456789,
                ))
                db.execute("ALTER TABLE manual_edits DROP COLUMN has_effective_mask")
                db.execute("UPDATE meta SET value='2' WHERE key='schema_version'")
            connection.close()

            migrated = WorkspaceStore(root)
            connection = sqlite3.connect(migrated.path)
            with connection as db:
                self.assertEqual(db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0], "3")
                self.assertIn("has_effective_mask", {row[1] for row in db.execute("PRAGMA table_info(manual_edits)")})
                self.assertEqual(db.execute("SELECT hidden,reviewed,candidate_revision FROM images WHERE image_id=?", (image_id,)).fetchone(), (1, 1, 42))
                self.assertEqual(db.execute("SELECT mask_png FROM candidates WHERE image_id=?", (image_id,)).fetchone()[0], b"candidate-mask")
                self.assertEqual(db.execute("""SELECT add_png,exclusion_png,exclusion_erase_png,manual_enabled,
                    exclusion_enabled,exclusion_erase_enabled,exclusion_forced,removed_candidate_ids,
                    candidate_revision,has_effective_mask,updated_at FROM manual_edits WHERE image_id=?""", (image_id,)).fetchone(), (
                    b"add-mask", b"exclude-mask", b"erase-mask", 0, 1, 0, 1, '["candidate"]', 42, 0, 123456789,
                ))
            connection.close()

            migrated.save_manual(image_id, {
                "add": "add", "exclusion": "exclude", "exclusionErase": "erase",
                "manualEnabled": True, "manualExclusionEnabled": False,
                "manualExclusionEraseEnabled": True, "manualExclusionForced": False,
                "removedCandidateIds": [], "candidateRevision": 7, "hasEffectiveMask": True,
            }, lambda value: value.encode() if value else None)
            connection = sqlite3.connect(migrated.path)
            with connection as db:
                self.assertEqual(db.execute("SELECT add_png,exclusion_png,exclusion_erase_png,has_effective_mask FROM manual_edits WHERE image_id=?", (image_id,)).fetchone(), (b"add", b"exclude", b"erase", 1))
            connection.close()

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
