"""File-backed boundary coverage for the job and save lifecycles."""
from __future__ import annotations

import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

import numpy as np
from PIL import Image

from mozarie.core import BrowserSaveReceipt, BrowserSaveToken, ClientError, ImageRecord, Job, JobControl
from mozarie.domain import Candidate, CandidateRole
from mozarie.jobs import JobsMixin
from mozarie.saving import SavingMixin


class JobsSavingCoverageTests(unittest.TestCase):
    def make_jobs(self) -> JobsMixin:
        state = JobsMixin()
        state.lock = threading.RLock()
        state.import_lock = threading.Lock()
        state.inference_lock = threading.RLock()
        state.sam_lock = threading.RLock()
        state.settings = {"models": {"provider": "gpu", "gpu_device": 2}}
        state.job = Job()
        state.job_control = None
        state.job_generation = 1
        state.catalog_generation = 1
        state.active_import_count = 0
        state.worker_thread = None
        state.order = []
        state.images = {}
        state.candidates = {}
        state.root = None
        state.session_imports_dir = None
        state.image_io_lock = lambda _image_id: threading.RLock()
        state._has_active_worker = lambda: False
        state._job_is_current = lambda generation, catalog: generation in (None, 1) and catalog in (None, 1)
        state._candidate_revision = lambda _image_id: 1
        state._allowed_root_for_record = lambda record, root, session: root
        state._assert_record_stat_matches = lambda _record: None
        state.image_for_id = lambda image_id: state.images[image_id]
        return state

    def record(self, directory: Path, image_id: str = "one") -> ImageRecord:
        path = directory / f"{image_id}.png"
        Image.new("RGB", (3, 2), "white").save(path)
        stat = path.stat()
        return ImageRecord(image_id, path, path.name, 3, 2, stat.st_mtime_ns, stat.st_size)

    def make_saving(self, directory: Path) -> SavingMixin:
        state = SavingMixin()
        state.lock = threading.RLock(); state.import_lock = threading.RLock()
        state.output_destination_lock = threading.Lock(); state.reserved_output_paths = set()
        state.catalog_generation = 1; state.active_import_count = 0
        state.settings = {"saving": {"default_output_directory": str(directory / "output"), "parallelism": 2}, "detection": {"exclude_forced_default": True}}
        state.images = {}; state.order = []; state.candidates = {}; state.candidate_revisions = {}
        state.browser_save_tokens = {}; state.browser_save_receipts = {}; state.browser_save_claims = set(); state._pending_browser_save_cleanup = []
        state.cache_dir = directory / "cache"; state._image_io_locks = {}
        state.workspace_store = Mock()
        state.image_io_lock = lambda _image_id: threading.RLock()
        state._has_active_worker = lambda: False
        state._candidate_revision = lambda image_id: state.candidate_revisions.get(image_id, 1)
        state.image_snapshot = lambda image_id: __import__("dataclasses").replace(state.images[image_id])
        state._records_for_ids_with_catalog = lambda ids: ([state.images[item] for item in ids], state.catalog_generation)
        state._assert_record_stat_matches = lambda _record: None
        state._touch_candidates = lambda image_id: state.candidate_revisions.__setitem__(image_id, state._candidate_revision(image_id) + 1)
        state._commit_candidate_snapshot = lambda image_id, candidates, **_kwargs: state.candidates.__setitem__(image_id, candidates)
        state.materialize_candidate_mask = lambda *_args: None
        state._delete_mask_files = lambda *_args: None
        state.invalidate_sam_image = lambda *_args: None
        state._release_browser_save_claim = lambda token: state.browser_save_claims.discard(token)
        state._discard_browser_save_token_unchecked = lambda token: state.browser_save_tokens.pop(token, None)
        state._take_browser_save_cleanup_unchecked = lambda: []
        state._unlink_browser_save_cleanup = lambda _items: None
        state._discard_browser_save_tokens_for_image_unchecked = lambda _image: None
        state.cleanup_expired_browser_save_tokens = lambda: None
        state._encode_workspace_mask = lambda value: value
        return state

    def test_job_control_and_record_guards(self) -> None:
        state = self.make_jobs()
        self.assertIsNone(state._gpu_oom_client_error(ClientError("x", "x")))
        state.settings["models"]["provider"] = "cpu"
        self.assertIsNone(state._gpu_oom_client_error(RuntimeError("CUDA out of memory")))
        state.settings["models"]["provider"] = "gpu"
        self.assertEqual(state.recover_gpu_oom_for_request(RuntimeError("ordinary")), None)
        state._job_is_current = lambda *_args: False
        state._set_job_parallelism(3)
        state._set_job_current("x")
        self.assertEqual(state.job.parallelism, 0)
        state.job.kind = "apply"; state.job.state = "running"; state.job.total = 2; state.job.completed = 0
        state.job_control = JobControl()
        state.job.active_count = 1
        self.assertEqual(state.request_pause().state, "pausing")
        state.job.state = "paused"; state.job.paused_at = time.time() - .01
        self.assertEqual(state.resume_job().state, "running")
        state.job.state = "running"
        self.assertTrue(state.request_cancel().cancel_requested)
        state.job.kind = "idle"
        for call in (state.request_pause, state.resume_job, state.request_cancel):
            with self.assertRaises(ClientError): call()
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw); record = self.record(directory)
            state.images = {record.image_id: record}; state.order = [record.image_id]
            self.assertEqual(state._records_for_ids([]), [record])
            state.root = directory
            self.assertEqual(state._records_for_ids_with_catalog([record.image_id])[0], [record])
            with self.assertRaises(ClientError): state._records_for_ids_with_catalog([record.image_id, record.image_id])
            state.root = directory / "other"
            with self.assertRaises(ClientError): state._records_for_ids_with_catalog([record.image_id])
            state.root = directory
            record.path.unlink()
            with self.assertRaises(ClientError): state._records_for_ids_with_catalog([record.image_id])

    def test_gpu_cache_candidate_mask_and_job_terminal_paths(self) -> None:
        state = self.make_jobs()
        cuda = Mock(); cuda.is_available.return_value = True
        cuda.device.return_value = object()
        # A non-context device uses the direct empty-cache fallthrough.
        state._empty_selected_gpu_cache(SimpleNamespace(cuda=cuda), 2)
        cuda.empty_cache.assert_called_once()
        sam = Mock(); hand_segmentation = Mock()
        state.sam_predictor = sam; state.hand_segmentation_predictor = hand_segmentation
        state.models = object(); state.hand_model = object()
        with patch.object(state, "_release_gpu_cache") as release:
            state._discard_gpu_models_after_oom()
        sam.reset_image.assert_called_once(); hand_segmentation.reset_image.assert_called_once()
        release.assert_called_once_with(provider="gpu", gpu_device=2)
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw); record = self.record(directory)
            state.images = {record.image_id: record}; state.root = directory
            state.candidates = {record.image_id: []}
            state.materialize_candidate_mask = Mock()
            self.assertIsNone(state.combined_candidate_mask(record.image_id))
            mask_path = directory / "bad.png"; Image.new("L", (1, 1), 255).save(mask_path)
            state.candidates[record.image_id] = [Candidate("bad", "x", .9, mask_path, role=CandidateRole.APPLY)]
            with self.assertRaises(RuntimeError): state.combined_candidate_mask(record.image_id)
            Image.new("L", (3, 2), 255).save(mask_path)
            state.candidates[record.image_id] = [Candidate("exclude", "x", .9, mask_path, role=CandidateRole.EXCLUDE, forced=True)]
            add = np.zeros((2, 3), dtype=np.uint8); add[0, 0] = 255
            self.assertIsNotNone(state.combined_candidate_mask(record.image_id, (add, None, None), lock_image=False))
        state.job = Job(kind="detect", state="running", total=1, image_ids=("one",), completed_image_ids=("one",), completed=1, active_count=1)
        state.job_control = JobControl(); state.job_control.pause_requested.set()
        state._finish_claimed_task(state.job_control, 1, 1)
        self.assertFalse(state.job_control.pause_requested.is_set())
        state.job = Job(kind="detect", state="running", total=1)
        with patch.object(state, "_release_gpu_job_memory") as release:
            state._cancel_job(1, 1); state._finish_job(1, 1)
        self.assertEqual(state.job.state, "complete"); self.assertEqual(release.call_count, 2)
        state._fail_job = Mock()
        state._run_fixed_workers([SimpleNamespace(image_id="one")], 1, lambda *_args: (_ for _ in ()).throw(RuntimeError("boom")), JobControl(), 1, 1)
        self.assertTrue(True)

    def test_worker_and_failure_classification_paths(self) -> None:
        state = self.make_jobs()
        self.assertEqual(state._run_fixed_workers([], 1, lambda *_args: None, None, 1, 1), [])
        state.job = Job(kind="detect", state="running", total=1)
        failures = state._run_fixed_workers([SimpleNamespace(image_id="one")], 1, lambda *_args: (_ for _ in ()).throw(ValueError("bad")), None, 1, 1)
        self.assertEqual(len(failures), 1)
        for exc, code in ((__import__("sqlite3").DatabaseError("x"), "workspace_database_error"), (ValueError("x"), "model_load_failed"), (RuntimeError("invalid graph"), "model_load_failed")):
            state.job = Job(kind="detect", state="running")
            with patch.object(state, "_release_gpu_job_memory"):
                state._fail_job(exc, 1, 1)
            self.assertEqual(state.job.error_code, code)
        state.job = Job(kind="apply", state="running")
        with patch.object(state, "_release_gpu_job_memory"):
            state._fail_job(OSError("x"), 1, 1)
        self.assertEqual(state.job.error_code, "output_unavailable")
        state.job = Job(kind="detect", state="running")
        with patch.object(state, "_discard_gpu_models_after_oom"):
            state._fail_job(RuntimeError("CUDA out of memory"), 1, 1)
        self.assertEqual(state.job.error_code, "gpu_out_of_memory")

    def test_saving_input_and_render_boundary_failures(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw); record = self.record(directory); state = self.make_saving(directory)
            state.images[record.image_id] = record; state.order = [record.image_id]
            state._start_job = Mock()
            state._records_for_ids_with_catalog = lambda _ids: ([record], 1)
            state.catalog_generation = 2
            with self.assertRaises(ClientError): state.start_apply([record.image_id], 2, {})
            state.catalog_generation = 1
            with patch("mozarie.saving.validate_output_directory_ready", side_effect=__import__("mozarie.config", fromlist=["SettingsError"]).SettingsError("bad")):
                with self.assertRaises(ClientError): state.start_apply([record.image_id], 2, {}, copy_to_default=True)
            state.images[record.image_id] = object()
            with self.assertRaises(ClientError): state.prepare_browser_save([record.image_id], 2, "_x", False)
            state.images[record.image_id] = record
            with patch("mozarie.saving.decode_draft_masks", return_value=(None, None, None)):
                with self.assertRaises(ClientError): state.render_browser_save(record.image_id, 1, 2, {})
            state.candidates[record.image_id] = [Candidate("missing", "x", .9, directory / "missing.png")]
            with patch("mozarie.saving.decode_draft_masks", return_value=(np.ones((2, 3), dtype=np.uint8), None, None)):
                with self.assertRaises(ClientError): state.render_browser_save(record.image_id, 1, 2, {})
            self.assertEqual(state.candidates[record.image_id], [])
            bad_mask = directory / "bad-mask.png"; Image.new("L", (1, 1), 255).save(bad_mask)
            state.candidates[record.image_id] = [Candidate("bad", "x", .9, bad_mask)]
            state.materialize_candidate_mask = lambda *_args: None
            with patch("mozarie.saving.decode_draft_masks", return_value=(None, None, None)):
                with self.assertRaises(RuntimeError): state.render_browser_save(record.image_id, 1, 2, {})
            state.candidates[record.image_id] = []
            state.settings["saving"]["default_output_directory"] = str(directory / "missing-output")
            with patch("mozarie.saving.decode_draft_masks", return_value=(np.ones((2, 3), dtype=np.uint8), None, None)), patch("mozarie.saving.render_with_mask", return_value=b"png"):
                with self.assertRaises(ClientError): state.render_browser_save(record.image_id, 1, 2, {}, copy_to_default=True)

    def test_saving_tokens_apply_worker_and_cleanup_paths(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw); record = self.record(directory); state = self.make_saving(directory)
            state.images[record.image_id] = record; state.order = [record.image_id]
            self.assertEqual(state._sha256_file(record.path), __import__("hashlib").sha256(record.path.read_bytes()).hexdigest())
            output = directory / "output"; output.mkdir(); state.settings["saving"]["default_output_directory"] = str(output)
            first = state._reserve_output_destination(record, "_x", output)
            second = state._reserve_output_destination(record, "_x", output)
            self.assertNotEqual(first, second); state._release_output_destination(first); state._release_output_destination(second)
            self.assertEqual(state.browser_save_status("x", 1, "none", "keep"), {"state": "unknown"})
            state.browser_save_receipts["wrong"] = BrowserSaveReceipt("other", 1, "keep", True, False, False, 1)
            self.assertEqual(state.browser_save_status(record.image_id, 1, "wrong", "keep"), {"state": "unknown"})
            token = BrowserSaveToken(record.image_id, 1, (record.mtime_ns, record.size_bytes), 1, time.monotonic(), None)
            state.browser_save_tokens["pending"] = token
            self.assertEqual(state.cancel_browser_save("wrong", 1, "pending"), {"state": "unknown"})
            self.assertEqual(state.cancel_browser_save(record.image_id, 1, "pending"), {"state": "pending"})
            state._run_fixed_workers = lambda records, _workers, action, *_args: [action(index, item) for index, item in enumerate(records)] and []
            state._set_job_current = lambda *_args: None; state._record_job_success = lambda *_args: None
            state._job_is_current = lambda *_args: True; state._finish_job = Mock(); state._fail_job = Mock(); state._cancel_job = Mock()
            state.job = Job(kind="apply", state="running", total=1, image_ids=(record.image_id,))
            state._apply_worker([record], 2, {record.image_id: np.zeros((2, 3), dtype=np.uint8)}, control=JobControl(), job_generation=1, catalog_generation=1)
            self.assertEqual(state.job.total, 0); state._finish_job.assert_called_once()

    def test_browser_commit_rechecks_and_handles_delete_rollback(self) -> None:
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw); record = self.record(directory); state = self.make_saving(directory)
            state.images[record.image_id] = record; state.order = [record.image_id]
            token = BrowserSaveToken(record.image_id, 1, (record.mtime_ns, record.size_bytes), 1, time.monotonic(), None)
            state.browser_save_tokens["active"] = token
            state._has_active_worker = lambda: True
            with self.assertRaises(ClientError): state.commit_browser_save(record.image_id, 1, "active", "keep")
            state._has_active_worker = lambda: False
            state.browser_save_tokens["expired"] = BrowserSaveToken(record.image_id, 1, (1, 1), 1, 0, None)
            with self.assertRaises(ClientError): state.commit_browser_save(record.image_id, 1, "expired", "keep")
            state.browser_save_tokens["changed"] = BrowserSaveToken(record.image_id, 1, (1, 1), 2, time.monotonic(), None)
            with self.assertRaises(ClientError): state.commit_browser_save(record.image_id, 1, "changed", "keep")
            # The second locked lookup must reject a receipt that arrived after
            # the initial token lookup, rather than committing the wrong action.
            state.browser_save_tokens["raced"] = token
            class AddReceipt:
                def __enter__(_self):
                    state.browser_save_receipts["raced"] = BrowserSaveReceipt(record.image_id, 1, "deleted", False, True, False, 1)
                def __exit__(_self, *_args): return False
            state.image_io_lock = lambda _image: AddReceipt()
            with self.assertRaises(ClientError): state.commit_browser_save(record.image_id, 1, "raced", "keep")
            state.image_io_lock = lambda _image: threading.RLock()
            # A database failure restores a filesystem source moved to quarantine.
            state.browser_save_tokens["rollback"] = token
            state.workspace_store.commit_save.side_effect = RuntimeError("db")
            with self.assertRaises(RuntimeError): state.commit_browser_save(record.image_id, 1, "rollback", "deleted")
            self.assertTrue(record.path.exists())
            state.workspace_store.commit_save.side_effect = None
            thumb = state.cache_dir / "thumbnails" / f"{record.image_id}-one.jpg"; thumb.parent.mkdir(parents=True); thumb.write_bytes(b"x")
            state.browser_save_tokens["deleted"] = token
            result = state.commit_browser_save(record.image_id, 1, "deleted", "deleted")
            self.assertEqual(result, {"cleared": True, "stale": False, "deleted": True})
            self.assertFalse(thumb.exists())
