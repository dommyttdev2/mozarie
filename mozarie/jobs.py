from __future__ import annotations

from .core import *
from .image_io import *
from . import image_io as _image_io

globals().update({name: value for name, value in vars(_image_io).items() if not name.startswith("__")})

class JobsMixin:
    def request_pause(self) -> Job:
        with self.lock:
            if self.job.kind not in {"apply", "detect"} or self.job.state != "running":
                raise ClientError("一時停止できる処理はありません。")
            assert self.job_control is not None
            self.job_control.pause_requested.set()
            return self.job

    def resume_job(self) -> Job:
        with self.lock:
            if self.job.kind not in {"apply", "detect"} or self.job.state != "paused":
                raise ClientError("再開できる処理はありません。")
            assert self.job_control is not None
            self.job_control.pause_requested.clear()
            self.job.state = "running"
            return self.job


    def request_cancel(self) -> Job:
        with self.lock:
            if self.job.kind not in {"apply", "detect"} or self.job.state not in {"running", "paused"}:
                raise ClientError("キャンセルできる処理はありません。")
            assert self.job_control is not None
            self.job_control.cancel_requested.set()
            self.job_control.pause_requested.clear()
            if self.job.state == "paused":
                self.job.state = "cancelled"
                self.job.current = ""
            return self.job

    def _records_for_ids(self, image_ids: list[str]) -> list[ImageRecord]:
        if not isinstance(image_ids, list):
            raise ClientError("画像の選択が正しくありません。")
        source_ids = image_ids or self.order
        if len({str(image_id) for image_id in source_ids}) != len(source_ids):
            raise ClientError("同じ画像を複数回指定できません。")
        records = [self.image_for_id(str(image_id)) for image_id in source_ids]
        if not records:
            raise ClientError("処理する画像がありません。")
        return records

    def _records_for_ids_with_catalog(self, image_ids: list[str]) -> tuple[list[ImageRecord], int]:
        if not isinstance(image_ids, list):
            raise ClientError("画像の選択が正しくありません。")
        with self.lock:
            source_ids = image_ids or list(self.order)
            if len({str(image_id) for image_id in source_ids}) != len(source_ids):
                raise ClientError("同じ画像を複数回指定できません。")
            records = [self.images.get(str(image_id)) for image_id in source_ids]
            root = self.root
            session_imports_dir = self.session_imports_dir
            catalog_generation = self.catalog_generation
        if not records or any(record is None for record in records):
            raise ClientError("処理する画像がありません。")
        verified_records = [record for record in records if record is not None]
        for record in verified_records:
            try:
                allowed_root = self._allowed_root_for_record(record, root, session_imports_dir)
                if allowed_root is None:
                    raise ValueError
                record.path.resolve().relative_to(allowed_root.resolve())
            except ValueError as exc:
                raise ClientError("許可されていない画像パスです。") from exc
            if not record.path.is_file():
                raise ClientError("画像ファイルが見つかりません。")
        for record in verified_records:
            self._assert_record_fresh(record)
        return verified_records, catalog_generation

    def _start_job(
        self,
        kind: str,
        records: list[ImageRecord],
        worker: Any,
        *args: Any,
        expected_catalog_generation: int | None = None,
        remove_after_save: bool = False,
    ) -> None:
        if not self.import_lock.acquire(blocking=False):
            raise ClientError("画像の追加中です。完了後にもう一度実行してください。")
        try:
            self._start_job_unlocked(
                kind,
                records,
                worker,
                *args,
                expected_catalog_generation=expected_catalog_generation,
                remove_after_save=remove_after_save,
            )
        finally:
            self.import_lock.release()

    def _start_job_unlocked(
        self,
        kind: str,
        records: list[ImageRecord],
        worker: Any,
        *args: Any,
        expected_catalog_generation: int | None = None,
        remove_after_save: bool = False,
    ) -> None:
        with self.lock:
            if self.importing_count or self.job.state in {"running", "paused"} or self._has_active_worker():
                raise ClientError("別の処理が進行中です。")
            if expected_catalog_generation is not None and self.catalog_generation != expected_catalog_generation:
                raise ClientError("画像一覧が更新されたため、もう一度実行してください。")
            self.job_generation += 1
            job_generation = self.job_generation
            catalog_generation = self.catalog_generation
            control = JobControl()
            self.job = Job(
                kind=kind,
                state="running",
                total=len(records),
                started_at=time.time(),
                image_ids=tuple(record.image_id for record in records),
                remove_after_save=remove_after_save,
            )
            self.job_control = control
        LOGGER.info("バックグラウンド処理を開始: %s (%d件)", JOB_LABELS.get(kind, kind), len(records))
        thread = threading.Thread(
            target=worker,
            args=(records, *args),
            kwargs={"control": control, "job_generation": job_generation, "catalog_generation": catalog_generation},
            daemon=True,
        )
        with self.lock:
            self.worker_thread = thread
        thread.start()


    def _wait_while_paused(self, control: JobControl | None, job_generation: int | None, catalog_generation: int | None) -> None:
        while control is not None and control.pause_requested.is_set() and not control.cancel_requested.is_set():
            with self.lock:
                if self._job_is_current(job_generation, catalog_generation):
                    self.job.state = "paused"
                    self.job.current = ""
            time.sleep(0.1)

    def _cancel_job(self, job_generation: int | None = None, catalog_generation: int | None = None) -> None:
        with self.lock:
            if self._job_is_current(job_generation, catalog_generation):
                self.job.state = "cancelled"
                self.job.current = ""
                self.job.active_count = 0

    def combined_candidate_mask(
        self,
        image_id: str,
        draft: tuple[np.ndarray | None, np.ndarray | None] | None = None,
    ) -> np.ndarray | None:
        record = self.image_for_id(image_id)
        add_mask, exclusion_mask = draft or (None, None)
        with self.lock:
            candidates = [candidate for candidate in self.candidates.get(image_id, []) if candidate.enabled]
            apply_candidates = [candidate for candidate in candidates if candidate.role == CandidateRole.APPLY]
            if not apply_candidates and add_mask is None:
                return None
            apply_masks: list[np.ndarray] = []
            exclude_masks: list[np.ndarray] = []
            for candidate in candidates:
                try:
                    with Image.open(candidate.mask_path) as mask_image:
                        mask = np.asarray(mask_image.convert("L"), dtype=np.uint8)
                except FileNotFoundError as exc:
                    raise ClientError("検出候補のマスクが見つかりません。自動検出をやり直してください。") from exc
                if mask.shape != (record.height, record.width):
                    raise RuntimeError("検出マスクのサイズが元画像と一致しません。")
                (apply_masks if candidate.role == CandidateRole.APPLY else exclude_masks).append(mask)
        return compose_masks((record.height, record.width), apply_masks, exclude_masks, add_mask, exclusion_mask)

    def _set_job_current(
        self,
        current: str,
        job_generation: int | None = None,
        catalog_generation: int | None = None,
    ) -> None:
        with self.lock:
            if self._job_is_current(job_generation, catalog_generation):
                self.job.current = current
                self.job.completed = len(self.job.completed_image_ids)

    def _mark_image_completed(
        self,
        image_id: str,
        job_generation: int | None = None,
        catalog_generation: int | None = None,
    ) -> None:
        with self.lock:
            if self._job_is_current(job_generation, catalog_generation) and image_id not in self.job.completed_image_ids:
                self.job.completed_image_ids = (*self.job.completed_image_ids, image_id)

    def _finish_job(self, job_generation: int | None = None, catalog_generation: int | None = None) -> None:
        with self.lock:
            if not self._job_is_current(job_generation, catalog_generation):
                return
            self.job.state = "complete"
            self.job.completed = self.job.total
            self.job.current = ""
            self.job.active_count = 0
            kind = self.job.kind
            total = self.job.total
        LOGGER.info("バックグラウンド処理が完了: %s (%d件)", JOB_LABELS.get(kind, kind), total)

    def _fail_job(self, exc: Exception, job_generation: int | None = None, catalog_generation: int | None = None) -> None:
        with self.lock:
            if not self._job_is_current(job_generation, catalog_generation):
                return
            kind = self.job.kind
            self.job.state = "error"
            self.job.error = str(exc)
            self.job.current = ""
            self.job.active_count = 0
        LOGGER.exception("バックグラウンド処理に失敗: %s", JOB_LABELS.get(kind, kind))
