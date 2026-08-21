from __future__ import annotations

from .core import *
from .core import _read_mosaic_divisor, _read_save_suffix
from .config import validate_output_directory_ready
from .image_io import *
from . import image_io as _image_io

globals().update({name: value for name, value in vars(_image_io).items() if not name.startswith("__")})

class SavingMixin:
    def start_apply(
        self,
        image_ids: list[str],
        divisor: int,
        drafts: dict[str, dict[str, Any]],
        remove_after_save: bool = False,
        copy_to_default: bool = False,
        suffix: str = "_censored",
    ) -> bool:
        records, catalog_generation = self._records_for_ids_with_catalog(image_ids)
        if not copy_to_default and any(record.source_kind != "filesystem" for record in records):
            raise ClientError("一時画像はコピー保存を選んでください。")
        if not isinstance(drafts, dict):
            raise ClientError("手描きマスクの形式が正しくありません。")
        suffix = _read_save_suffix(suffix)
        with self.lock:
            if self.catalog_generation != catalog_generation or any(self.images.get(record.image_id) is not record for record in records):
                raise ClientError("画像一覧が更新されたため、もう一度実行してください。")
            records = [replace(record) for record in records]
            output_directory = Path(self.settings["saving"]["default_output_directory"])
            saving_parallelism = int(self.settings.get("saving", {}).get("parallelism", 2))
        if copy_to_default:
            try:
                output_directory = validate_output_directory_ready(output_directory)
            except SettingsError as exc:
                raise ClientError("保存先フォルダを使用できません。設定で変更してください。") from exc
        drafts = {str(image_id): (dict(draft) if isinstance(draft, dict) else draft) for image_id, draft in drafts.items()}
        self._start_job(
            "apply", records, self._apply_worker, divisor, drafts, copy_to_default, suffix,
            saving_parallelism, output_directory,
            expected_catalog_generation=catalog_generation, remove_after_save=remove_after_save,
        )
        return True

    def _reserve_output_destination(self, record: ImageRecord, suffix: str, output_directory: Path) -> Path:
        """Reserve a copy name while another worker may be choosing one."""
        with self.output_destination_lock:
            relative = safe_import_relative_path(record.relative_path)
            target = output_directory / relative
            destination = unique_session_import_destination(
                target.with_name(f"{target.stem}{_read_save_suffix(suffix)}{target.suffix}"), self.reserved_output_paths,
            )
            self.reserved_output_paths.add(destination)
            return destination

    def _release_output_destination(self, destination: Path) -> None:
        with self.output_destination_lock:
            self.reserved_output_paths.discard(destination)

    def prepare_browser_save(
        self,
        image_ids: list[str],
        divisor: int,
        suffix: str,
        delete_original: bool,
    ) -> list[dict[str, Any]]:
        records, _catalog_generation = self._records_for_ids_with_catalog(image_ids)
        _read_mosaic_divisor(divisor)
        _read_save_suffix(suffix)
        with self.lock:
            if any(self.images.get(record.image_id) is not record for record in records):
                raise ClientError("画像一覧が変更されました。保存をやり直してください。")
            return [
                {
                    "imageId": record.image_id,
                    "relativePath": record.relative_path,
                    "sourceKind": record.source_kind,
                    "candidateRevision": self._candidate_revision(record.image_id),
                    "sourceAction": "deleted" if delete_original and record.source_kind == "filesystem" else "keep",
                }
                for record in records
            ]

    def render_browser_save(
        self,
        image_id: str,
        revision: int,
        divisor: int,
        draft: Any,
        *,
        copy_to_default: bool = False,
        suffix: str = "_censored",
    ) -> BrowserSaveRender:
        record = self.image_snapshot(image_id)
        draft_masks = decode_draft_masks(draft, record.width, record.height)
        divisor = _read_mosaic_divisor(divisor)
        rendered_path: Path | None = None
        output_path: Path | None = None
        configured_output_directory: Path | None = None
        image_lock = self.image_io_lock(image_id)
        try:
            # The per-image lock comes first.  The state lock only captures an
            # immutable epoch; PNG decode, source reads, rendering and fsync do
            # not block requests for other images.
            with image_lock:
                with self.lock:
                    current_record = self.images.get(image_id)
                    if current_record is None or current_record.path != record.path:
                        raise ClientError("画像が見つかりません。フォルダを再読込してください。")
                    record = replace(current_record)
                    if self._has_active_worker():
                        raise ClientError("バックグラウンド処理中は保存できません。完了後にもう一度実行してください。")
                    current_revision = self._candidate_revision(image_id)
                    if revision != current_revision:
                        raise ClientError("候補が変更されました。保存をやり直してください。")
                    catalog_generation = self.catalog_generation
                    candidates = [replace(candidate) for candidate in self.candidates.get(image_id, [])]
                    if copy_to_default:
                        configured_output_directory = Path(self.settings["saving"]["default_output_directory"]).resolve()
                # A candidate can disappear between the metadata snapshot and the
                # disk read.  Do not compose a silently reduced mask.
                apply_masks: list[np.ndarray] = []
                exclude_masks: list[np.ndarray] = []
                add_mask, exclusion_mask = draft_masks
                enabled_apply_candidates = [candidate for candidate in candidates if candidate.enabled and candidate.role == CandidateRole.APPLY]
                if not enabled_apply_candidates and add_mask is None:
                    raise ClientError("保存するモザイク範囲がありません。")
                for candidate in candidates:
                    try:
                        with Image.open(candidate.mask_path) as mask_image:
                            candidate_mask = np.asarray(mask_image.convert("L"), dtype=np.uint8)
                    except FileNotFoundError as exc:
                        with self.lock:
                            if self.images.get(image_id) is not None:
                                self._remove_candidate_unchecked(image_id, candidate.candidate_id)
                                self._touch_candidates(image_id)
                        raise ClientError("候補が変更されました。保存をやり直してください。") from exc
                    if candidate_mask.shape != (record.height, record.width):
                        raise RuntimeError("検出マスクのサイズが元画像と一致しません。")
                    if candidate.enabled:
                        (apply_masks if candidate.role == CandidateRole.APPLY else exclude_masks).append(candidate_mask)
                mask = compose_masks((record.height, record.width), apply_masks, exclude_masks, add_mask, exclusion_mask)
                if mask is None or not np.any(mask):
                    raise ClientError("保存するモザイク範囲がありません。")
                output, source_digest = render_with_mask(record, mask, calculate_block_size(record.width, record.height, divisor))
                source_fingerprint = (record.mtime_ns, record.size_bytes, source_digest)
                self._assert_record_stat_matches(record)
                if copy_to_default:
                    if not configured_output_directory.is_dir():
                        raise ClientError("保存先フォルダを使用できません。設定で変更してください。")
                    output_path = self._reserve_output_destination(
                        record, _read_save_suffix(suffix), configured_output_directory,
                    )
                    try:
                        write_rendered_copy(output_path, output)
                    except OSError as exc:
                        raise ClientError("保存先フォルダへ保存できませんでした。設定で変更してください。") from exc
                    finally:
                        self._release_output_destination(output_path)
                else:
                    rendered_dir = self.cache_dir / "browser-save"
                    rendered_dir.mkdir(parents=True, exist_ok=True)
                    with tempfile.NamedTemporaryFile(dir=rendered_dir, suffix=record.path.suffix.lower(), delete=False) as handle:
                        rendered_path = Path(handle.name)
                        handle.write(output)
                        handle.flush()

                with self.lock:
                    if (
                        self.images.get(image_id) is None
                        or self.catalog_generation != catalog_generation
                        or (configured_output_directory is not None
                            and Path(self.settings["saving"]["default_output_directory"]).resolve() != configured_output_directory)
                    ):
                        raise ClientError("画像一覧が変更されました。保存をやり直してください。")
                    if self._has_active_worker():
                        raise ClientError("バックグラウンド処理中は保存できません。完了後にもう一度実行してください。")
                    save_token = self._issue_browser_save_token_unchecked(
                        record, current_revision, source_fingerprint, catalog_generation, rendered_path,
                    )
                    rendered_path = None
            return BrowserSaveRender(output, record, current_revision, save_token, output_path)
        finally:
            if rendered_path is not None:
                rendered_path.unlink(missing_ok=True)
            if output_path is not None and 'save_token' not in locals():
                output_path.unlink(missing_ok=True)

    def commit_browser_save(self, image_id: str, revision: int, save_token: str, source_action: str) -> dict[str, Any]:
        if not isinstance(save_token, str) or not save_token:
            raise ClientError("保存確認トークンがありません。保存をやり直してください。")
        if source_action not in {"keep", "overwrite", "deleted"}:
            raise ClientError("元画像の処理は keep、overwrite、deleted のいずれかで指定してください。")
        rendered_path: Path | None = None
        mask_paths: list[Path] = []
        candidate_dirs: list[Path] = []
        thumbnail_paths: list[Path] = []
        expired_token = False
        with self.import_lock:
            with self.lock:
                receipt = self.browser_save_receipts.get(save_token)
                if receipt is not None:
                    if receipt.image_id != image_id or receipt.candidate_revision != revision or receipt.source_action != source_action:
                        raise ClientError("保存確認トークンが保存対象と一致しません。保存をやり直してください。")
                    return {"cleared": receipt.cleared, "stale": receipt.stale, "deleted": receipt.deleted, "images": self.list_images()}
                token_details = self.browser_save_tokens.get(save_token)
                if token_details is None:
                    raise ClientError("保存確認トークンが無効または期限切れです。保存をやり直してください。")
                if token_details.image_id != image_id or token_details.candidate_revision != revision:
                    raise ClientError("保存確認トークンが保存対象と一致しません。保存をやり直してください。")
                if source_action == "overwrite" and token_details.rendered_path is None:
                    raise ClientError("コピー保存の確認トークンでは上書き保存できません。")
            image_lock = self.image_io_lock(image_id)
            with image_lock:
                with self.lock:
                    receipt = self.browser_save_receipts.get(save_token)
                    if receipt is not None:
                        if receipt.image_id != image_id or receipt.candidate_revision != revision or receipt.source_action != source_action:
                            raise ClientError("保存確認トークンが保存対象と一致しません。保存をやり直してください。")
                        return {"cleared": receipt.cleared, "stale": receipt.stale, "deleted": receipt.deleted, "images": self.list_images()}
                    token_details = self.browser_save_tokens.get(save_token)
                    record = self.images.get(image_id)
                    if token_details is None:
                        raise ClientError("保存確認トークンが無効または期限切れです。保存をやり直してください。")
                    if token_details.image_id != image_id or token_details.candidate_revision != revision:
                        raise ClientError("保存確認トークンが保存対象と一致しません。保存をやり直してください。")
                    if source_action == "overwrite" and token_details.rendered_path is None:
                        raise ClientError("コピー保存の確認トークンでは上書き保存できません。")
                    if token_details.issued_at < time.monotonic() - SAVE_TOKEN_TTL_SECONDS:
                        rendered_path = self.browser_save_tokens.pop(save_token).rendered_path
                        expired_token = True
                    catalog_invalid = token_details.catalog_generation != self.catalog_generation or record is None
                    if expired_token:
                        pass
                    elif catalog_invalid:
                        rendered_path = self.browser_save_tokens.pop(save_token).rendered_path
                    elif self._has_active_worker():
                        raise ClientError("バックグラウンド処理中は保存を完了できません。完了後にもう一度実行してください。")
                    else:
                        record_snapshot = replace(record)
                        catalog_generation = self.catalog_generation
                        # Claim only after the per-image lock is held. Polling
                        # cleanup cannot remove the render while source I/O runs.
                        self.browser_save_tokens.pop(save_token)

                if expired_token:
                    if rendered_path is not None:
                        rendered_path.unlink(missing_ok=True)
                    raise ClientError("保存確認トークンが無効または期限切れです。保存をやり直してください。")
                if catalog_invalid:
                    if rendered_path is not None:
                        rendered_path.unlink(missing_ok=True)
                    raise ClientError("画像一覧が変更されました。保存をやり直してください。")

                try:
                    if source_action == "overwrite":
                        assert token_details.rendered_path is not None
                        _replace_record_with_rendered_output(record_snapshot, token_details.rendered_path, token_details.source_fingerprint[2])
                    else:
                        self._assert_record_stat_matches(record_snapshot)
                    if source_action == "deleted":
                        # Browser-imported files are removed through their File
                        # System Access handle before this commit.  The server
                        # owns deletion for filesystem catalogue records.
                        if record_snapshot.source_kind != "session" or record_snapshot.path.exists():
                            record_snapshot.path.unlink()
                except ClientError:
                    rendered_path = token_details.rendered_path
                    if rendered_path is not None:
                        rendered_path.unlink(missing_ok=True)
                    raise
                except OSError as exc:
                    rendered_path = token_details.rendered_path
                    if rendered_path is not None:
                        rendered_path.unlink(missing_ok=True)
                    raise ClientError("元画像を変更できませんでした。候補は保持しています。") from exc

                with self.lock:
                    record = self.images.get(image_id)
                    if record is None or self.catalog_generation != catalog_generation:
                        raise ClientError("画像一覧が変更されました。保存をやり直してください。")
                    current_revision = self._candidate_revision(image_id)
                    deleted = source_action == "deleted"
                    cleared = revision == current_revision
                    if source_action == "overwrite":
                        record.mtime_ns = record_snapshot.mtime_ns
                        record.size_bytes = record_snapshot.size_bytes
                        record.asset_revision = record_snapshot.asset_revision + 1
                    if deleted:
                        mask_paths = [candidate.mask_path for candidate in self.candidates.get(image_id, [])]
                        candidate_dirs = [self.cache_dir / image_id]
                        self.images.pop(image_id, None)
                        self.order = [current_id for current_id in self.order if current_id != image_id]
                        self.candidate_revisions.pop(image_id, None)
                        self.candidates.pop(image_id, None)
                        self._image_io_locks.pop(image_id, None)
                    elif cleared:
                        mask_paths = [candidate.mask_path for candidate in self.candidates.get(image_id, [])]
                        candidate_dirs = [self.cache_dir / image_id]
                        self.candidates[image_id] = []
                        self._touch_candidates(image_id)
                    self.browser_save_receipts[save_token] = BrowserSaveReceipt(image_id, revision, source_action, cleared, not cleared, deleted, time.monotonic())
                    rendered_path = token_details.rendered_path
                    if deleted:
                        self._discard_browser_save_tokens_for_image_unchecked(image_id)
                if deleted:
                    thumbnail_paths = list((self.cache_dir / "thumbnails").glob(f"{image_id}-*.jpg"))
                if mask_paths:
                    self._delete_mask_files(mask_paths, candidate_dirs)
                if deleted:
                    self.cleanup_expired_browser_save_tokens()
                for thumbnail_path in thumbnail_paths:
                    thumbnail_path.unlink(missing_ok=True)
                if rendered_path is not None:
                    rendered_path.unlink(missing_ok=True)
                self.invalidate_sam_image(image_id)
                return {"cleared": cleared, "stale": not cleared, "deleted": deleted, "images": self.list_images()}


    def _apply_worker(
        self,
        records: list[ImageRecord],
        divisor: int,
        drafts_or_masks: dict[str, Any],
        copy_to_default: bool = False,
        suffix: str = "_censored",
        saving_parallelism: int = 1,
        output_directory: Path | None = None,
        *,
        control: JobControl | None = None,
        job_generation: int | None = None,
        catalog_generation: int | None = None,
    ) -> None:
        try:
            empty_indices: set[int] = set()
            output_directory = output_directory or Path(self.settings["saving"]["default_output_directory"])

            def save_record(index: int, record: ImageRecord) -> None:
                with self.image_io_lock(record.image_id):
                    self._set_job_current(record.relative_path, job_generation, catalog_generation)
                    draft_or_mask = drafts_or_masks.get(record.image_id)
                    try:
                        mask = (draft_or_mask if isinstance(draft_or_mask, np.ndarray) else self.combined_candidate_mask(
                            record.image_id, decode_draft_masks(draft_or_mask, record.width, record.height)
                        ))
                    except Exception:
                        raise
                    if mask is None or not np.any(mask):
                        with self.lock:
                            empty_indices.add(index)
                        return
                    output_path = self._reserve_output_destination(record, suffix, output_directory) if copy_to_default else record.path
                    if copy_to_default:
                        try:
                            output, _source_digest = render_with_mask(record, mask, calculate_block_size(record.width, record.height, divisor))
                            self._assert_record_stat_matches(record)
                            write_rendered_copy(output_path, output)
                        finally:
                            self._release_output_destination(output_path)
                    else:
                        save_with_mask(record, mask, calculate_block_size(record.width, record.height, divisor))
                        output_stat = record.path.stat()
                    # Files are fully written before the state mutation. A failed
                    # record therefore keeps its masks, while successful records clear once.
                    with self.lock:
                        if not self._job_is_current(job_generation, catalog_generation):
                            return
                        if not copy_to_default:
                            record.mtime_ns = output_stat.st_mtime_ns
                            record.size_bytes = output_stat.st_size
                            record.asset_revision += 1
                        mask_paths = [candidate.mask_path for candidate in self.candidates.get(record.image_id, [])]
                        self.candidates[record.image_id] = []
                        self._touch_candidates(record.image_id)
                        self._record_job_success(index, record.image_id, str(output_path), job_generation, catalog_generation)
                    self._delete_mask_files(mask_paths, [self.cache_dir / record.image_id])
                    self.invalidate_sam_image(record.image_id)
                    self._set_job_current(record.relative_path, job_generation, catalog_generation)

            failures = self._run_fixed_workers(
                records, min(8, max(1, saving_parallelism)), save_record,
                control, job_generation, catalog_generation,
            )
            if failures:
                self._fail_job(failures[0][1], job_generation, catalog_generation)
            elif len(empty_indices) == len(records):
                self._fail_job(ClientError("保存するモザイク範囲がありません。"), job_generation, catalog_generation)
            elif control is not None and control.cancel_requested.is_set():
                self._cancel_job(job_generation, catalog_generation)
            else:
                if empty_indices:
                    with self.lock:
                        if self._job_is_current(job_generation, catalog_generation):
                            kept_indices = [index for index in range(len(records)) if index not in empty_indices]
                            slots = getattr(self, "_job_output_slots", {})
                            completed = set(self.job.completed_image_ids)
                            self.job.image_ids = tuple(records[index].image_id for index in kept_indices)
                            self.job.total = len(kept_indices)
                            self.job.completed_image_ids = tuple(image_id for image_id in self.job.image_ids if image_id in completed)
                            self.job.completed = len(self.job.completed_image_ids)
                            self.job.outputs = [slots[index] for index in kept_indices if index in slots]
                self._finish_job(job_generation, catalog_generation)
        except Exception as exc:
            self._fail_job(exc, job_generation, catalog_generation)
