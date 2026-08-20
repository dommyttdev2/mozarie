from __future__ import annotations

from .core import *
from .core import _read_mosaic_divisor, _read_save_suffix, _read_target_classes
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
        eligible_records: list[ImageRecord] = []
        for record in records:
            draft_masks = decode_draft_masks(drafts.get(record.image_id), record.width, record.height)
            mask = self.combined_candidate_mask(record.image_id, draft_masks)
            if mask is not None and np.any(mask):
                eligible_records.append(record)
            del mask, draft_masks
        records = eligible_records
        if not records:
            raise ClientError("保存するモザイク範囲がありません。")
        suffix = _read_save_suffix(suffix)
        self._start_job(
            "apply", records, self._apply_worker, divisor, drafts, copy_to_default, suffix,
            int(self.settings.get("saving", {}).get("parallelism", 2)),
            expected_catalog_generation=catalog_generation, remove_after_save=remove_after_save,
        )
        return True

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
    ) -> tuple[bytes, ImageRecord, int, str]:
        record = self.image_for_id(image_id)
        draft_masks = decode_draft_masks(draft, record.width, record.height)
        with self.lock:
            current_record = self.images.get(image_id)
            if current_record is not record:
                raise ClientError("画像が見つかりません。フォルダを再読込してください。")
            if self._has_active_worker():
                raise ClientError("バックグラウンド処理中は保存できません。完了後にもう一度実行してください。")

            # A vanished mask changes the candidate state; force a fresh render rather
            # than silently composing a different image under the old revision.
            stored_candidates = self.candidates.get(image_id, [])
            candidates = [candidate for candidate in stored_candidates if candidate.mask_path.is_file()]
            if len(candidates) != len(stored_candidates):
                self.candidates[image_id] = candidates
                self._touch_candidates(image_id)
            current_revision = self._candidate_revision(image_id)
            if revision != current_revision:
                raise ClientError("候補が変更されました。保存をやり直してください。")

            source_fingerprint = self._source_fingerprint(record)
            catalog_generation = self.catalog_generation
            enabled_candidates = [candidate for candidate in candidates if candidate.enabled]
            add_mask, exclusion_mask = draft_masks
            enabled_apply_candidates = [candidate for candidate in enabled_candidates if candidate.role == CandidateRole.APPLY]
            if not enabled_apply_candidates and add_mask is None:
                raise ClientError("保存するモザイク範囲がありません。")
            apply_masks: list[np.ndarray] = []
            exclude_masks: list[np.ndarray] = []
            for candidate in enabled_candidates:
                try:
                    with Image.open(candidate.mask_path) as mask_image:
                        candidate_mask = np.asarray(mask_image.convert("L"), dtype=np.uint8)
                except FileNotFoundError:
                    self._remove_candidate_unchecked(image_id, candidate.candidate_id)
                    self._touch_candidates(image_id)
                    raise ClientError("検出候補のマスクが見つかりません。保存をやり直してください。")
                if candidate_mask.shape != (record.height, record.width):
                    raise RuntimeError("検出マスクのサイズが元画像と一致しません。")
                (apply_masks if candidate.role == CandidateRole.APPLY else exclude_masks).append(candidate_mask)
            mask = compose_masks((record.height, record.width), apply_masks, exclude_masks, add_mask, exclusion_mask)
        if mask is None or not np.any(mask):
            raise ClientError("保存するモザイク範囲がありません。")
        divisor = _read_mosaic_divisor(divisor)
        output = render_with_mask(record, mask, calculate_block_size(record.width, record.height, divisor))
        with self.lock:
            if self.catalog_generation != catalog_generation:
                raise ClientError("画像一覧が変更されました。保存をやり直してください。")
            save_token = self._issue_browser_save_token_unchecked(
                record, current_revision, source_fingerprint, catalog_generation, output,
            )
        return output, record, current_revision, save_token

    def commit_browser_save(self, image_id: str, revision: int, save_token: str, source_action: str) -> dict[str, Any]:
        if not isinstance(save_token, str) or not save_token:
            raise ClientError("保存確認トークンがありません。保存をやり直してください。")
        if source_action not in {"keep", "overwrite", "deleted"}:
            raise ClientError("元画像の処理は keep、overwrite、deleted のいずれかで指定してください。")
        with self.lock:
            self._discard_expired_browser_save_tokens_unchecked()
            receipt = self.browser_save_receipts.get(save_token)
            if receipt is not None:
                if (
                    receipt.image_id != image_id
                    or receipt.candidate_revision != revision
                    or receipt.source_action != source_action
                ):
                    raise ClientError("保存確認トークンが保存対象と一致しません。保存をやり直してください。")
                return {
                    "cleared": receipt.cleared,
                    "stale": receipt.stale,
                    "deleted": receipt.deleted,
                    "images": self.list_images(),
                }
            token_details = self.browser_save_tokens.get(save_token)
            if token_details is None:
                raise ClientError("保存確認トークンが無効または期限切れです。保存をやり直してください。")
            if token_details.image_id != image_id or token_details.candidate_revision != revision:
                raise ClientError("保存確認トークンが保存対象と一致しません。保存をやり直してください。")
            if token_details.catalog_generation != self.catalog_generation:
                self._discard_browser_save_token_unchecked(save_token)
                raise ClientError("画像一覧が変更されました。保存をやり直してください。")
            record = self.images.get(image_id)
            if record is None:
                self._discard_browser_save_token_unchecked(save_token)
                raise ClientError("画像が見つかりません。フォルダを再読込してください。")
            if self._has_active_worker():
                raise ClientError("バックグラウンド処理中は保存を完了できません。完了後にもう一度実行してください。")
            try:
                current_fingerprint = self._source_fingerprint(record)
            except ClientError:
                self._discard_browser_save_token_unchecked(save_token)
                raise
            if current_fingerprint != token_details.source_fingerprint:
                self._discard_browser_save_token_unchecked(save_token)
                raise ClientError("元画像が変更されました。保存をやり直してください。")
            current_revision = self._candidate_revision(image_id)
            deleted = False
            try:
                if source_action == "overwrite":
                    _replace_record_with_rendered_output(record, token_details.rendered_path)
                elif source_action == "deleted":
                    if record.source_kind == "filesystem":
                        record.path.unlink()
                    self._cleanup_record_working_state_unchecked(record, remove_session_source=True)
                    self.images.pop(record.image_id, None)
                    self.order = [current_id for current_id in self.order if current_id != record.image_id]
                    self.candidate_revisions.pop(record.image_id, None)
                    self.candidates.pop(record.image_id, None)
                    deleted = True
                cleared = revision == current_revision
                if cleared and not deleted:
                    self._clear_masks_unchecked([record])
            except OSError as exc:
                self._discard_browser_save_token_unchecked(save_token)
                raise ClientError("元画像を変更できませんでした。候補は保持しています。") from exc
            except Exception:
                self._discard_browser_save_token_unchecked(save_token)
                raise
            self.browser_save_receipts[save_token] = BrowserSaveReceipt(
                image_id=image_id,
                candidate_revision=revision,
                source_action=source_action,
                cleared=cleared,
                stale=not cleared,
                deleted=deleted,
                completed_at=time.monotonic(),
            )
            self._discard_browser_save_token_unchecked(save_token)
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
        *,
        control: JobControl | None = None,
        job_generation: int | None = None,
        catalog_generation: int | None = None,
    ) -> None:
        try:
            if len(records) > 1 and saving_parallelism > 1:
                def save_record(record: ImageRecord) -> bool:
                    if not self._job_is_current(job_generation, catalog_generation):
                        return False
                    self._wait_while_paused(control, job_generation, catalog_generation)
                    if control is not None and control.cancel_requested.is_set():
                        return False
                    self._set_job_current(record.relative_path, job_generation, catalog_generation)
                    self._assert_record_fresh(record)
                    draft_or_mask = drafts_or_masks.get(record.image_id)
                    mask = draft_or_mask if isinstance(draft_or_mask, np.ndarray) else self.combined_candidate_mask(
                        record.image_id, decode_draft_masks(draft_or_mask, record.width, record.height)
                    )
                    if mask is None or not np.any(mask):
                        raise ClientError("検出候補のマスクが見つかりません。自動検出をやり直してください。")
                    if copy_to_default:
                        destination = _default_output_destination(record, suffix)
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        write_rendered_copy(destination, render_with_mask(record, mask, calculate_block_size(record.width, record.height, divisor)))
                    else:
                        save_with_mask(record, mask, calculate_block_size(record.width, record.height, divisor))
                        output_stat = record.path.stat()
                        record.mtime_ns = output_stat.st_mtime_ns
                        record.size_bytes = output_stat.st_size
                        record.content_version += 1
                    with self.lock:
                        self.job.outputs.append(str(destination if copy_to_default else record.path))
                        self._clear_masks_unchecked([record])
                    self.invalidate_sam_image(record.image_id)
                    self._mark_image_completed(record.image_id, job_generation, catalog_generation)
                    return True

                with ThreadPoolExecutor(max_workers=min(8, saving_parallelism, len(records))) as executor:
                    results = [future.result() for future in (executor.submit(save_record, record) for record in records)]
                if control is not None and control.cancel_requested.is_set() or not all(results):
                    self._cancel_job(job_generation, catalog_generation)
                else:
                    self._finish_job(job_generation, catalog_generation)
                return
            for record in records:
                if not self._job_is_current(job_generation, catalog_generation):
                    return
                if control is not None and control.cancel_requested.is_set():
                    self._cancel_job(job_generation, catalog_generation)
                    return
                self._wait_while_paused(control, job_generation, catalog_generation)
                if control is not None and control.cancel_requested.is_set():
                    self._cancel_job(job_generation, catalog_generation)
                    return
                self._set_job_current(record.relative_path, job_generation, catalog_generation)
                self._assert_record_fresh(record)
                draft_or_mask = drafts_or_masks.get(record.image_id)
                if isinstance(draft_or_mask, np.ndarray):
                    mask = draft_or_mask
                else:
                    draft_masks = decode_draft_masks(draft_or_mask, record.width, record.height)
                    mask = self.combined_candidate_mask(record.image_id, draft_masks)
                if mask is None or not np.any(mask):
                    raise ClientError("検出候補のマスクが見つかりません。自動検出をやり直してください。")
                if copy_to_default:
                    destination = _default_output_destination(record, suffix)
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    write_rendered_copy(destination, render_with_mask(record, mask, calculate_block_size(record.width, record.height, divisor)))
                else:
                    save_with_mask(record, mask, calculate_block_size(record.width, record.height, divisor))
                    output_stat = record.path.stat()
                    record.mtime_ns = output_stat.st_mtime_ns
                    record.size_bytes = output_stat.st_size
                    record.content_version += 1
                with self.lock:
                    self.job.outputs.append(str(destination if copy_to_default else record.path))
                self.invalidate_sam_image(record.image_id)
                with self.lock:
                    self._clear_masks_unchecked([record])
                self._mark_image_completed(record.image_id, job_generation, catalog_generation)
                self._set_job_current(record.relative_path, job_generation, catalog_generation)
                if control is not None and control.pause_requested.is_set():
                    with self.lock:
                        if self._job_is_current(job_generation, catalog_generation):
                            self.job.state = "paused"
                            self.job.current = ""
                    while control.pause_requested.is_set() and not control.cancel_requested.is_set():
                        time.sleep(0.1)
                    if control.cancel_requested.is_set():
                        self._cancel_job(job_generation, catalog_generation)
                        return
            self._finish_job(job_generation, catalog_generation)
        except Exception as exc:
            self._fail_job(exc, job_generation, catalog_generation)

