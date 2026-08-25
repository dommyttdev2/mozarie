import sqlite3
import tempfile
import unittest
import io
from pathlib import Path
from types import SimpleNamespace

from PIL import Image

from mozarie.workspace import WorkspaceStore


class WorkspaceV040Tests(unittest.TestCase):
    def _image(self, root: Path):
        return SimpleNamespace(relative_path="001.png", size_bytes=10, mtime_ns=20)

    @staticmethod
    def _png(value: int = 255) -> bytes:
        output = io.BytesIO()
        Image.new("L", (4, 4), value).save(output, format="PNG")
        return output.getvalue()

    @staticmethod
    def _points_png(points: list[tuple[int, int]]) -> bytes:
        image = Image.new("L", (4, 4))
        for point in points:
            image.putpixel(point, 255)
        output = io.BytesIO(); image.save(output, format="PNG")
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
                    image_id, "candidate", "person", 0.9, self._png(), 1, "#123456", "detector",
                    "automatic", "refined", "apply", 0, 0,
                ))
                db.execute("""INSERT INTO manual_edits(
                    image_id,add_png,exclusion_png,exclusion_erase_png,manual_enabled,exclusion_enabled,
                    exclusion_erase_enabled,exclusion_forced,removed_candidate_ids,candidate_revision,updated_at
                ) VALUES(?,?,?,?,?,?,?,?,?,?,?)""", (
                    image_id, self._png(), self._png(), self._png(), 0, 1, 0, 1,
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
                self.assertEqual(db.execute("SELECT mask_png FROM candidates WHERE image_id=?", (image_id,)).fetchone()[0], self._png())
                self.assertEqual(db.execute("""SELECT add_png,exclusion_png,exclusion_erase_png,manual_enabled,
                    exclusion_enabled,exclusion_erase_enabled,exclusion_forced,removed_candidate_ids,
                    candidate_revision,has_effective_mask,updated_at FROM manual_edits WHERE image_id=?""", (image_id,)).fetchone(), (
                    self._png(), self._png(), self._png(), 0, 1, 0, 1, '["candidate"]', 42, 0, 123456789,
                ))
            connection.close()

            migrated.save_manual(image_id, {
                "add": "add", "exclusion": "exclude", "exclusionErase": "erase",
                "manualEnabled": True, "manualExclusionEnabled": False,
                "manualExclusionEraseEnabled": True, "manualExclusionForced": False,
                "removedCandidateIds": [], "candidateRevision": 7, "hasEffectiveMask": True,
            }, lambda value: self._png() if value else None)
            connection = sqlite3.connect(migrated.path)
            with connection as db:
                self.assertEqual(db.execute("SELECT add_png,exclusion_png,exclusion_erase_png,has_effective_mask FROM manual_edits WHERE image_id=?", (image_id,)).fetchone(), (self._png(), self._png(), self._png(), 1))
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

    def test_v2_migration_ignores_stale_removed_candidate_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            catalog = store.ensure_catalog()
            image_id = str(store.reconcile_images(catalog, [self._image(root)])["001.png"]["image_id"])
            connection = sqlite3.connect(store.path)
            with connection as db:
                db.execute("UPDATE images SET candidate_revision=2 WHERE image_id=?", (image_id,))
                db.execute("INSERT INTO candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (
                    image_id, "candidate", "penis", 0.9, self._png(), 1, "#123456", "detector", "automatic", None, "apply", 0, 0,
                ))
                db.execute("INSERT INTO manual_edits(image_id,removed_candidate_ids,candidate_revision,updated_at) VALUES(?,?,?,?)", (image_id, '["candidate"]', 1, 1))
                db.execute("ALTER TABLE manual_edits DROP COLUMN has_effective_mask")
                db.execute("UPDATE meta SET value='2' WHERE key='schema_version'")
            connection.close()
            migrated = WorkspaceStore(root)
            self.assertTrue(migrated.manual_effective_masks([image_id])[image_id])

    def test_v2_migration_composes_manual_exclusions_and_erase(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            catalog = store.ensure_catalog()
            records = [SimpleNamespace(relative_path=f"{name}.png", size_bytes=10, mtime_ns=20) for name in ("manual", "excluded", "erased")]
            ids = {path: row["image_id"] for path, row in store.reconcile_images(catalog, records).items()}
            connection = sqlite3.connect(store.path)
            with connection as db:
                db.execute("INSERT INTO manual_edits(image_id,add_png,removed_candidate_ids,candidate_revision,updated_at) VALUES(?,?,?,?,?)", (ids["manual.png"], self._png(), "[]", 0, 1))
                for image_id, role in ((ids["excluded.png"], "apply"), (ids["excluded.png"], "exclude"), (ids["erased.png"], "apply")):
                    db.execute("INSERT INTO candidates VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", (image_id, f"{image_id}-{role}", "penis", 0.9, self._png(), 1, "#123456", "detector", "automatic", None, role, 0, 0))
                db.execute("INSERT INTO manual_edits(image_id,removed_candidate_ids,candidate_revision,updated_at) VALUES(?,?,?,?)", (ids["excluded.png"], "[]", 0, 1))
                db.execute("INSERT INTO manual_edits(image_id,exclusion_png,removed_candidate_ids,candidate_revision,updated_at) VALUES(?,?,?,?,?)", (ids["erased.png"], self._png(), "[]", 0, 1))
                db.execute("UPDATE manual_edits SET exclusion_erase_png=? WHERE image_id=?", (self._points_png([(1, 1)]), ids["erased.png"]))
                db.execute("ALTER TABLE manual_edits DROP COLUMN has_effective_mask")
                db.execute("UPDATE meta SET value='2' WHERE key='schema_version'")
            connection.close()
            migrated = WorkspaceStore(root)
            self.assertEqual(migrated.manual_effective_masks(list(ids.values())), {
                ids["manual.png"]: True, ids["excluded.png"]: False, ids["erased.png"]: True,
            })

    def test_invalid_v2_png_rolls_back_without_changing_schema(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = WorkspaceStore(root)
            catalog = store.ensure_catalog()
            image_id = str(store.reconcile_images(catalog, [self._image(root)])["001.png"]["image_id"])
            connection = sqlite3.connect(store.path)
            with connection as db:
                db.execute("INSERT INTO manual_edits(image_id,add_png,removed_candidate_ids,candidate_revision,updated_at) VALUES(?,?,?,?,?)", (image_id, b"not-a-png", "[]", 0, 1))
                db.execute("ALTER TABLE manual_edits DROP COLUMN has_effective_mask")
                db.execute("UPDATE meta SET value='2' WHERE key='schema_version'")
            connection.close()
            with self.assertRaisesRegex(ValueError, "PNG"):
                WorkspaceStore(root)
            check_connection = sqlite3.connect(store.path)
            with check_connection as db:
                self.assertEqual(db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()[0], "2")
                self.assertNotIn("has_effective_mask", {row[1] for row in db.execute("PRAGMA table_info(manual_edits)")})
            check_connection.close()


if __name__ == "__main__":
    unittest.main()
