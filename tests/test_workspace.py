import sqlite3
import tempfile
import unittest
import io
from pathlib import Path
from types import SimpleNamespace

from PIL import Image

from mozarie.catalog import CatalogMixin
from mozarie.workspace import WorkspaceStore


class WorkspaceTests(unittest.TestCase):
    def _image(self, root: Path):
        return SimpleNamespace(relative_path="001.png", size_bytes=10, mtime_ns=20)

    @staticmethod
    def _png(value: int = 255) -> bytes:
        output = io.BytesIO()
        Image.new("L", (4, 4), value).save(output, format="PNG")
        return output.getvalue()

    def test_manual_effective_presence_uses_scalar_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            store = WorkspaceStore(Path(directory))
            catalog = store.ensure_catalog()
            image_id = store.reconcile_images(catalog, [self._image(Path(directory))])["001.png"]["image_id"]
            store.save_manual(str(image_id), {"add": "x", "manualEnabled": True, "hasEffectiveMask": True}, lambda value: self._png() if value else None)
            self.assertEqual(store.manual_effective_masks([str(image_id)]), {str(image_id): True})

    def test_manual_effective_mask_requires_the_client_scalar(self):
        with tempfile.TemporaryDirectory() as directory:
            store = WorkspaceStore(Path(directory))
            catalog = store.ensure_catalog()
            image_id = str(store.reconcile_images(catalog, [self._image(Path(directory))])["001.png"]["image_id"])
            with self.assertRaisesRegex(ValueError, "effective mask"):
                store.save_manual(image_id, {"add": "x"}, lambda value: b"png" if value else None)

    def test_hydrate_candidates_rejects_corrupt_masks_without_partial_result(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            catalog = store.ensure_catalog()
            image_id = str(store.reconcile_images(catalog, [self._image(root)])["001.png"]["image_id"])
            connection = sqlite3.connect(store.path)
            with connection as db:
                for candidate_id, mask in (("valid", self._png()), ("broken", b"not a PNG")):
                    db.execute("""INSERT INTO candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                        image_id, candidate_id, "penis", 0.9, mask, 1, "#123456", "detector",
                        "automatic", None, "apply", 0, 0,
                    ))
            connection.close()
            constructed: list[str] = []
            with self.assertRaisesRegex(ValueError, "PNG"):
                store.hydrate_candidates(image_id, root / "cache", lambda row, _path: constructed.append(str(row["candidate_id"])))
            self.assertEqual(constructed, [])

            connection = sqlite3.connect(store.path)
            with connection as db:
                db.execute("UPDATE candidates SET mask_png=0 WHERE image_id=? AND candidate_id=?", (image_id, "broken"))
            connection.close()
            with self.assertRaisesRegex(ValueError, "PNG"):
                store.hydrate_candidates(image_id, root / "cache", lambda _row, _path: None)

    def test_hydrate_candidates_propagates_invalid_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            catalog = store.ensure_catalog()
            image_id = str(store.reconcile_images(catalog, [self._image(root)])["001.png"]["image_id"])
            connection = sqlite3.connect(store.path)
            with connection as db:
                db.execute("""INSERT INTO candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                    image_id, "candidate", "penis", 0.9, self._png(), 1, "#123456", "detector",
                    "automatic", None, "invalid-role", 0, 0,
                ))
            connection.close()
            with self.assertRaisesRegex(ValueError, "invalid-role"):
                store.hydrate_candidates(image_id, root / "cache", CatalogMixin._candidate_from_workspace)

    def test_manual_rejects_corrupt_persisted_values_and_propagates_encoder_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            catalog = store.ensure_catalog()
            image_id = str(store.reconcile_images(catalog, [self._image(root)])["001.png"]["image_id"])
            store.save_manual(image_id, {
                "add": "add", "exclusion": "exclusion", "exclusionErase": "erase",
                "removedCandidateIds": [], "candidateRevision": 0, "hasEffectiveMask": False,
            }, lambda _value: self._png())
            for column in ("add_png", "exclusion_png", "exclusion_erase_png"):
                connection = sqlite3.connect(store.path)
                with connection as db:
                    db.execute(f"UPDATE manual_edits SET {column}=? WHERE image_id=?", (b"not a PNG", image_id))
                connection.close()
                with self.assertRaisesRegex(ValueError, "PNG"):
                    store.manual(image_id, lambda value: value)
                connection = sqlite3.connect(store.path)
                with connection as db:
                    db.execute(f"UPDATE manual_edits SET {column}=? WHERE image_id=?", (self._png(), image_id))
                connection.close()
            for removed in ("not JSON", '["candidate", 1]'):
                connection = sqlite3.connect(store.path)
                with connection as db:
                    db.execute("UPDATE manual_edits SET removed_candidate_ids=? WHERE image_id=?", (removed, image_id))
                connection.close()
                with self.assertRaises(ValueError):
                    store.manual(image_id, lambda value: value)
            connection = sqlite3.connect(store.path)
            with connection as db:
                db.execute("UPDATE manual_edits SET removed_candidate_ids='[]' WHERE image_id=?", (image_id,))
            connection.close()
            with self.assertRaisesRegex(RuntimeError, "encoder failed"):
                store.manual(image_id, lambda _value: (_ for _ in ()).throw(RuntimeError("encoder failed")))

    def test_manual_returns_none_only_when_no_row_exists(self):
        with tempfile.TemporaryDirectory() as directory:
            store = WorkspaceStore(Path(directory))
            self.assertIsNone(store.manual("missing", lambda value: value))

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

    def test_v2_database_is_rejected_without_schema_mutation(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            connection = sqlite3.connect(store.path)
            with connection as db:
                db.execute("ALTER TABLE manual_edits DROP COLUMN has_effective_mask")
                db.execute("UPDATE meta SET value='2' WHERE key='schema_version'")
            connection.close()
            before = store.path.read_bytes()
            with self.assertRaisesRegex(RuntimeError, "recreated"):
                WorkspaceStore(root)
            self.assertEqual(store.path.read_bytes(), before)
            connection = sqlite3.connect(store.path)
            self.assertEqual(connection.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0], "2")
            self.assertNotIn("has_effective_mask", {row[1] for row in connection.execute("PRAGMA table_info(manual_edits)")})
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

    def test_manual_save_normalizes_removed_ids_to_current_candidates_and_revision(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            catalog = store.ensure_catalog()
            image_id = str(store.reconcile_images(catalog, [self._image(root)])["001.png"]["image_id"])
            connection = sqlite3.connect(store.path)
            with connection as db:
                db.execute("UPDATE images SET candidate_revision=9 WHERE image_id=?", (image_id,))
                db.execute("""INSERT INTO candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
                    image_id, "current", "penis", 0.9, self._png(), 1, "#123456", "detector",
                    "automatic", None, "apply", 0, 0,
                ))
            connection.close()
            store.save_manual(image_id, {
                "add": "", "exclusion": "", "exclusionErase": "", "removedCandidateIds": ["stale", "current", "current"],
                "candidateRevision": 2, "hasEffectiveMask": False,
            }, lambda value: self._png() if value else None)
            manual = store.manual(image_id, lambda value: value)
            self.assertEqual(manual["removedCandidateIds"], ["current"])
            self.assertEqual(manual["candidateRevision"], 9)

    def test_bulk_workspace_queries_accept_more_than_sqlite_variable_limit(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            catalog = store.ensure_catalog()
            records = [SimpleNamespace(relative_path=f"{index}.png", size_bytes=10, mtime_ns=20) for index in range(1100)]
            ids = [item["image_id"] for item in store.reconcile_images(catalog, records).values()]
            store.delete_images(ids)
            self.assertEqual(store.manual_mask_statuses(ids), {})

if __name__ == "__main__":
    unittest.main()
