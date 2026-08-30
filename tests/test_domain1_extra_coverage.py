"""Additional file-backed regression coverage for catalog/state/workspace edges."""

from __future__ import annotations

import io
import sqlite3
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

import mozarie.state as state_module
from mozarie.core import Candidate, CandidateRole, ClientError, ImageRecord
from mozarie.state import StudioState, cuda_device_statuses, gpu_device_statuses
from mozarie.workspace import WorkspaceOpenError, WorkspaceStore


def png(mode: str = "L") -> bytes:
    stream = io.BytesIO()
    Image.new(mode, (4, 4), 255 if mode in {"L", "1"} else "white").save(stream, format="PNG")
    return stream.getvalue()


class WorkspaceExtraCoverageTests(unittest.TestCase):
    def make_store(self, root: Path) -> tuple[WorkspaceStore, str, str]:
        store = WorkspaceStore(root)
        catalog_id = store.ensure_catalog()
        item = SimpleNamespace(relative_path="one.png", size_bytes=10, mtime_ns=20)
        return store, catalog_id, str(store.reconcile_images(catalog_id, [item])["one.png"]["image_id"])

    def test_schema_and_transaction_failures_are_visible(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            db = sqlite3.connect(root / "bad.sqlite3")
            try:
                db.execute("CREATE TABLE only_one(value TEXT)")
                with self.assertRaises(WorkspaceOpenError):
                    WorkspaceStore._validate_schema(db, {"only_one"})
            finally:
                db.close()
            store, catalog_id, image_id = self.make_store(root)
            db = sqlite3.connect(store.path)
            try:
                db.execute("CREATE TRIGGER reject_image_insert BEFORE INSERT ON images BEGIN SELECT RAISE(ABORT, 'no'); END")
                db.commit()
            finally:
                db.close()
            with self.assertRaises(sqlite3.DatabaseError):
                store.reconcile_images(catalog_id, [SimpleNamespace(relative_path="two.png", size_bytes=1, mtime_ns=1)])
            db = sqlite3.connect(store.path)
            try:
                db.execute("DROP TRIGGER reject_image_insert")
                db.execute("INSERT INTO manual_edits(image_id,removed_candidate_ids,candidate_revision,has_effective_mask,updated_at) VALUES(?, ?, 0, 0, 0)", (image_id, '"bad"'))
                db.commit()
            finally:
                db.close()
            with self.assertRaises(ValueError):
                store.commit_candidate_state(image_id, 1, [], False, replace=False)
            with self.assertRaises(ValueError):
                store.save_manual("missing", {"add": None, "exclusion": None, "exclusionErase": None, "removedCandidateIds": [], "hasEffectiveMask": False}, lambda value: value)

    def test_candidate_state_round_trip_and_missing_blob(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store, _catalog_id, image_id = self.make_store(root)
            mask_path = root / "candidate.png"
            mask_path.write_bytes(png())
            candidate = Candidate("candidate", "penis", .8, mask_path)
            store.commit_candidate_state(image_id, 1, [candidate], True, replace=True)
            candidate.enabled = False
            store.commit_candidate_state(image_id, 2, [candidate], False, replace=False)
            self.assertEqual(store.valid_candidate_ids(image_id), {"candidate"})
            self.assertEqual(store.hydrate_candidates_bulk([image_id], root / "cache", lambda row, path: (row["candidate_id"], path))[image_id][0], 2)
            db = sqlite3.connect(store.path)
            try:
                db.execute("UPDATE candidates SET mask_png='not-bytes' WHERE image_id=?", (image_id,))
                db.commit()
            finally:
                db.close()
            with self.assertRaises(ValueError):
                store.hydrate_candidates_bulk([image_id], root / "cache", lambda *_: None)

    def test_restored_candidate_keeps_its_durable_mask(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store, _catalog_id, image_id = self.make_store(root)
            mask_path = root / "candidate.png"
            mask_path.write_bytes(png())
            candidate = Candidate("candidate", "penis", .8, mask_path)
            store.commit_candidate_state(image_id, 1, [candidate], True, replace=True)
            mask_path.unlink()
            candidate.enabled = False
            store.commit_candidate_state(image_id, 2, [candidate], True, replace=True)
            self.assertEqual(store.candidate_png(image_id, "candidate"), png())

    def test_prune_and_unmaterialized_candidate_failures_roll_back(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store, catalog_id, image_id = self.make_store(root)
            db = sqlite3.connect(store.path)
            try:
                db.execute("CREATE TRIGGER reject_prune BEFORE DELETE ON images BEGIN SELECT RAISE(ABORT, 'no'); END")
                db.commit()
            finally:
                db.close()
            with self.assertRaises(sqlite3.DatabaseError):
                store.prune_catalog_images(catalog_id, set())
            db = sqlite3.connect(store.path)
            try:
                db.execute("DROP TRIGGER reject_prune")
                db.commit()
            finally:
                db.close()
            missing = Candidate("not-stored", "penis", .5, root / "not-stored.png")
            store.commit_candidate_state(image_id, 1, [missing], True, replace=True)
            self.assertIsNone(store.candidate_png(image_id, "not-stored"))

    def test_schema_metadata_and_manual_payload_rejections(self) -> None:
        class InvalidPng:
            format = "JPEG"

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def load(self) -> None:
                return None

        class SchemaView:
            def __init__(self, db: sqlite3.Connection, *, bad_primary: bool = False, bad_foreign: bool = False) -> None:
                self.db = db
                self.bad_primary = bad_primary
                self.bad_foreign = bad_foreign
                self.catalog_info_calls = 0

            def execute(self, sql: str):
                if sql == "PRAGMA table_info(catalogs)":
                    self.catalog_info_calls += 1
                    rows = list(self.db.execute(sql))
                    if self.bad_primary and self.catalog_info_calls == 2:
                        return [{**dict(row), "pk": 0} for row in rows]
                    return rows
                if self.bad_foreign and sql == "PRAGMA foreign_key_list(images)":
                    return []
                return self.db.execute(sql)

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store, _catalog_id, image_id = self.make_store(root)
            db = store._connect()
            try:
                tables = {str(row[0]) for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
                with self.assertRaises(WorkspaceOpenError):
                    WorkspaceStore._validate_schema(SchemaView(db, bad_primary=True), tables)
                with self.assertRaises(WorkspaceOpenError):
                    WorkspaceStore._validate_schema(SchemaView(db, bad_foreign=True), tables)
            finally:
                db.close()
            with patch("mozarie.workspace.Image.open", return_value=InvalidPng()):
                with self.assertRaises(ValueError):
                    WorkspaceStore._decode_png_mask(png())
            for payload in (
                {"add": None, "exclusion": None, "exclusionErase": None, "removedCandidateIds": "bad", "hasEffectiveMask": False},
                {"add": None, "exclusion": None, "exclusionErase": None, "removedCandidateIds": [], "hasEffectiveMask": "bad"},
            ):
                with self.assertRaises(ValueError):
                    store.save_manual(image_id, payload, lambda value: value)


class StateCatalogExtraCoverageTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        app = self.root / "app"
        (app / "config").mkdir(parents=True)
        (app / "config" / "defaults.json").write_bytes((Path(__file__).resolve().parents[1] / "config" / "defaults.json").read_bytes())
        with patch.object(state_module, "APP_DIR", app):
            self.state = StudioState(self.root / "cache", self.root / "sessions")

    def tearDown(self) -> None:
        self.state.shutdown()
        self.temp.cleanup()

    def add_image(self) -> str:
        image = self.root / "source.png"
        Image.new("RGB", (4, 4), "white").save(image)
        return self.state.set_root(str(self.root))[0]["id"]

    def test_gpu_status_reset_and_diagnostic_errors(self) -> None:
        self.assertEqual(cuda_device_statuses(SimpleNamespace(cuda=SimpleNamespace(is_available=lambda: False))), [])
        cuda = SimpleNamespace(cuda=SimpleNamespace(
            is_available=lambda: True, get_arch_list=lambda: ["sm_90"], device_count=lambda: 1,
            get_device_capability=lambda _i: (9, 0), get_device_name=lambda _i: "GPU",
            get_device_properties=lambda _i: SimpleNamespace(total_memory=10),
        ))
        self.assertTrue(cuda_device_statuses(cuda)[0]["supported"])
        with patch.object(state_module, "runtime_backend", return_value="directml"), patch.object(state_module, "directml_devices", side_effect=OSError("no adapter")):
            self.assertEqual(gpu_device_statuses(cuda), [])
        with patch("mozarie.inference.onnx.diagnose_runtime", side_effect=RuntimeError("broken")):
            with self.assertRaises(ClientError) as context:
                self.state.diagnose_gpu_runtime()
            self.assertEqual(context.exception.error_code, "gpu_unavailable")
        self.assertEqual(self.state.reset_settings()["models"]["provider"], self.state.settings["models"]["provider"])

    def test_stale_session_cleanup_does_not_touch_live_imports(self) -> None:
        session_root = self.root / "sessions"
        stale = session_root / "session-old"
        stale.mkdir(parents=True)
        old = 1
        import os
        os.utime(stale, (old, old))
        fresh = session_root / "session-fresh"
        fresh.mkdir()
        self.state._cleanup_stale_sessions()
        self.assertFalse(stale.exists())
        self.assertTrue(fresh.exists())
        imports = self.state._ensure_session()
        self.assertEqual(self.state._ensure_session(), imports)
        detached = self.state._detach_session_unchecked()
        self.state._release_detached_session(detached)
        self.assertFalse(imports.exists())

    def test_settings_status_reports_actual_bad_paths(self) -> None:
        settings = self.state.settings_store.default_settings()
        models = settings["models"]
        models["sam_model_type"] = "vit_h"
        models["target_segmentation"] = str(self.root / "wrong.txt")
        (self.root / "wrong.txt").write_text("x")
        settings["detection"]["mode"] = "high_precision"
        checkpoint = self.root / "checkpoint.bin"
        checkpoint.write_text("x")
        models["sam_checkpoints"][models["sam_model_type"]] = str(checkpoint)
        mismatch = self.root / "sam_vit_l_0b3195.pth"
        mismatch.write_text("x")
        models["sam_checkpoints"]["vit_b"] = str(mismatch)
        status = self.state.settings_status(settings)
        self.assertEqual(status["models"]["target_segmentation"]["reasonCode"], "invalid_format")
        self.assertEqual(status["models"]["sam_checkpoint"]["reasonCode"], "invalid_format")
        self.assertEqual(status["samVariants"]["vit_b"]["reasonCode"], "type_mismatch")
        self.state.end_import_transfer()

    def test_catalogue_guards_and_candidate_bulk_state(self) -> None:
        image_id = self.add_image()
        with self.assertRaises(ClientError):
            self.state.remove_images_from_catalog("not-a-list")  # type: ignore[arg-type]
        with self.assertRaises(ClientError):
            self.state._import_images(["invalid"], include_images=False)  # type: ignore[list-item]
        mask = self.root / "mask.png"
        mask.write_bytes(png())
        apply = Candidate("apply", "penis", .9, mask, role=CandidateRole.APPLY)
        excluded = Candidate("exclude", "penis", .9, self.root / "exclude.png", role=CandidateRole.EXCLUDE)
        excluded.mask_path.write_bytes(png())
        self.state.candidates[image_id] = [apply, excluded]
        self.state._commit_candidate_snapshot(image_id, [apply, excluded], replace=True)
        self.state.set_candidate_state(image_id, "exclude", {"forced": True, "color": "#102030"})
        self.state.batch_update_candidates(image_id, {"role": "apply", "operation": "disable"})
        self.state.batch_update_candidates(image_id, {"role": "exclude", "operation": "delete"})
        self.assertTrue(self.state.delete_candidate(image_id, "apply"))

    def test_mask_path_tokens_and_model_configuration_errors(self) -> None:
        image_id = self.add_image()
        item = self.state.images[image_id]
        token = self.state._issue_browser_save_token_unchecked(item, 0, (item.mtime_ns, item.size_bytes), self.state.catalog_generation, None)
        self.state.browser_save_tokens[token] = replace(self.state.browser_save_tokens[token], issued_at=0)
        self.state.cleanup_expired_browser_save_tokens()
        self.assertNotIn(token, self.state.browser_save_tokens)
        item.path = self.root / "missing.png"
        with self.assertRaises(ClientError):
            self.state.image_for_id(image_id)
        item.path = self.root / "source.png"
        self.state.settings["models"]["hand_segmentation"] = ""
        with self.assertRaises(ClientError) as context:
            self.state._hand_segmentation_predictor_for(item, object())
        self.assertEqual(context.exception.error_code, "model_not_configured")
        model = self.root / "not-model.txt"
        model.write_text("x")
        self.state.settings["models"]["hand_segmentation"] = str(model)
        with self.assertRaises(ClientError) as context:
            self.state._hand_segmentation_predictor_for(item, object())
        self.assertEqual(context.exception.error_code, "model_file_invalid")

    def test_worker_guard_and_cache_cleanup(self) -> None:
        image_id = self.add_image()
        self.state.worker_thread = SimpleNamespace(is_alive=lambda: True)
        with self.assertRaises(ClientError):
            self.state.clear_masks([image_id])
        with self.assertRaises(ClientError):
            self.state.batch_update_candidates(image_id, {"role": "apply", "operation": "enable"})
        self.state.worker_thread = None
        self.state.cache_dir.mkdir(parents=True, exist_ok=True)
        (self.state.cache_dir / ".active.lock").write_bytes(b"1")
        (self.state.cache_dir / "file").write_text("x")
        self.state._clear_cache()
        self.assertTrue((self.state.cache_dir / ".active.lock").exists())
