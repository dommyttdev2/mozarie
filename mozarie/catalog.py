from __future__ import annotations

from .core import *
from .image_io import *
from . import image_io as _image_io

globals().update({name: value for name, value in vars(_image_io).items() if not name.startswith("__")})

class CatalogMixin:
    def _replace_catalog(self, root: Path, records: list[ImageRecord]) -> list[dict[str, Any]]:
        with self.lock:
            self._assert_catalog_mutable()
            self.images = {record.image_id: record for record in records}
            self.order = [record.image_id for record in records]
            self.candidates = {}
            self.candidate_revisions = {record.image_id: 0 for record in records}
            self._clear_browser_save_tokens_unchecked()
            self.root = root
            self._clear_cache()
            self._invalidate_sam_cache()
            self.job = Job()
            self.catalog_generation += 1
            self._clear_session_unchecked()
        return self.list_images()

    def _has_active_worker(self) -> bool:
        return self.worker_thread is not None and self.worker_thread.is_alive()

    def _assert_catalog_mutable(self) -> None:
        if self.importing_count or self.job.state in {"running", "paused"} or self._has_active_worker():
            raise ClientError("処理が終了するまで画像一覧を変更できません。")

    def _job_is_current(self, job_generation: int | None, catalog_generation: int | None) -> bool:
        return (
            (job_generation is None or self.job_generation == job_generation)
            and (catalog_generation is None or self.catalog_generation == catalog_generation)
        )

    def set_root(self, raw_path: str) -> list[dict[str, Any]]:
        with self.import_lock:
            return self._set_root(raw_path)

    def _set_root(self, raw_path: str) -> list[dict[str, Any]]:
        if not raw_path or not isinstance(raw_path, str):
            raise ClientError("Windowsフォルダを入力してください。")
        root = Path(raw_path).expanduser().resolve()
        if not root.is_dir():
            raise ClientError("指定フォルダが見つかりません。")
        with self.lock:
            self._assert_catalog_mutable()

        records: list[ImageRecord] = []
        for path in root.rglob("*"):
            if not path.is_file() or path.suffix.lower() not in IMAGE_SUFFIXES:
                continue
            try:
                resolved = path.resolve()
                resolved.relative_to(root)
                with Image.open(resolved) as image:
                    _assert_image_suffix_matches_format(resolved.suffix, image.format)
                    width, height = oriented_image_size(image)
                stat = resolved.stat()
            except (OSError, UnidentifiedImageError, ValueError):
                continue
            records.append(
                ImageRecord(
                    image_id=uuid.uuid4().hex,
                    path=resolved,
                    relative_path=resolved.relative_to(root).as_posix(),
                    width=width,
                    height=height,
                    mtime_ns=stat.st_mtime_ns,
                    size_bytes=stat.st_size,
                )
            )

        records.sort(key=lambda record: record.relative_path.lower())
        return self._replace_catalog(root, records)

    def clear_catalog(self) -> None:
        with self.import_lock:
            with self.lock:
                self._assert_catalog_mutable()
                self.images = {}
                self.order = []
                self.candidates = {}
                self.candidate_revisions = {}
                self._clear_browser_save_tokens_unchecked()
                self._clear_cache()
                self._invalidate_sam_cache()
                self.catalog_generation += 1
                self._clear_session_unchecked()

    def remove_image_from_catalog(self, image_id: str) -> list[dict[str, Any]]:
        """Remove one image's working state without deleting its source file."""
        return self.remove_images_from_catalog([image_id])["images"]

    def remove_images_from_catalog(self, image_ids: list[str]) -> dict[str, Any]:
        """Remove saved images from the working catalog without deleting source files."""
        if not isinstance(image_ids, list):
            raise ClientError("画像IDの一覧が正しくありません。")
        requested_ids = list(dict.fromkeys(str(image_id) for image_id in image_ids if str(image_id)))
        if not requested_ids:
            raise ClientError("削除する画像がありません。")
        with self.import_lock:
            with self.lock:
                self._assert_catalog_mutable()
                records = [self.images[image_id] for image_id in requested_ids if image_id in self.images]
                removed_ids = [record.image_id for record in records]
                for record in records:
                    self._cleanup_record_working_state_unchecked(record, remove_session_source=True)
                    self.images.pop(record.image_id, None)
                    self.candidates.pop(record.image_id, None)
                    self.candidate_revisions.pop(record.image_id, None)
                if removed_ids:
                    removed_set = set(removed_ids)
                    self.order = [current_id for current_id in self.order if current_id not in removed_set]
                self._clear_browser_save_tokens_unchecked()
                if removed_ids:
                    self.catalog_generation += 1
        for image_id in removed_ids:
            self.invalidate_sam_image(image_id)
        return {"images": self.list_images(), "removedImageIds": removed_ids}

    def shutdown(self) -> None:
        """Stop background work before releasing the session import directory."""
        with self.lock:
            worker = self.worker_thread
            control = self.job_control
            self._clear_browser_save_tokens_unchecked()
            self.browser_save_receipts.clear()
            if control is not None:
                control.cancel_requested.set()
                control.pause_requested.clear()
        if worker is not None and worker.is_alive():
            worker.join(timeout=5)
        if worker is not None and worker.is_alive():
            LOGGER.warning("Background worker did not stop before shutdown; retaining this process cache.")
            return
        with self.import_lock:
            with self.lock:
                self._clear_session_unchecked()
                self._clear_browser_save_tokens_unchecked()
                if self._owns_process_cache:
                    self._release_directory_lock(self._cache_lock_handle)
                    self._cache_lock_handle = None
                    shutil.rmtree(self.cache_dir, ignore_errors=True)

    def _touch_candidates(self, image_id: str) -> int:
        revision = self.candidate_revisions.get(image_id, 0) + 1
        self.candidate_revisions[image_id] = revision
        return revision

    def _candidate_revision(self, image_id: str) -> int:
        return self.candidate_revisions.get(image_id, 0)

    def _source_fingerprint(self, record: ImageRecord) -> tuple[int, int, int, str]:
        self._assert_record_fresh(record)
        try:
            source_digest = model_sha256(record.path)
        except OSError as exc:
            raise ClientError("Could not read the source image for saving.") from exc
        return record.mtime_ns, record.size_bytes, record.content_version, source_digest

    def _discard_browser_save_token_unchecked(self, token: str) -> BrowserSaveToken | None:
        details = self.browser_save_tokens.pop(token, None)
        if details is not None:
            details.rendered_path.unlink(missing_ok=True)
        return details

    def _clear_browser_save_tokens_unchecked(self) -> None:
        for token in tuple(self.browser_save_tokens):
            self._discard_browser_save_token_unchecked(token)

    def _discard_browser_save_tokens_for_image_unchecked(self, image_id: str) -> None:
        for token, details in tuple(self.browser_save_tokens.items()):
            if details.image_id == image_id:
                self._discard_browser_save_token_unchecked(token)

    def _discard_expired_browser_save_tokens_unchecked(self) -> None:
        cutoff = time.monotonic() - SAVE_TOKEN_TTL_SECONDS
        for token, details in tuple(self.browser_save_tokens.items()):
            if details.issued_at < cutoff:
                self._discard_browser_save_token_unchecked(token)
        for token, receipt in tuple(self.browser_save_receipts.items()):
            if receipt.completed_at < cutoff:
                self.browser_save_receipts.pop(token, None)

    def _issue_browser_save_token_unchecked(
        self,
        record: ImageRecord,
        revision: int,
        source_fingerprint: tuple[int, int],
        catalog_generation: int,
        output: bytes,
    ) -> str:
        self._discard_expired_browser_save_tokens_unchecked()
        token = secrets.token_urlsafe(32)
        rendered_dir = self.cache_dir / "browser-save"
        rendered_dir.mkdir(parents=True, exist_ok=True)
        rendered_path = rendered_dir / f"{token}{record.path.suffix.lower()}"
        with rendered_path.open("xb") as handle:
            handle.write(output)
            handle.flush()
            os.fsync(handle.fileno())
        self.browser_save_tokens[token] = BrowserSaveToken(
            image_id=record.image_id,
            candidate_revision=revision,
            source_fingerprint=source_fingerprint,
            catalog_generation=catalog_generation,
            issued_at=time.monotonic(),
            rendered_path=rendered_path,
        )
        return token

    def _assert_record_fresh(self, record: ImageRecord) -> None:
        try:
            stat = record.path.stat()
        except OSError as exc:
            raise ClientError("元画像が外部で変更または削除されました。画像を再読み込みしてください。") from exc
        if (
            stat.st_mtime_ns != record.mtime_ns
            or (record.size_bytes > 0 and stat.st_size != record.size_bytes)
        ):
            raise ClientError("元画像が外部で変更されました。画像を再読み込みしてください。")

    def clear_masks(self, image_ids: list[str]) -> int:
        records = self._records_for_ids(image_ids)
        with self.lock:
            if self.importing_count or self.job.state in {"running", "paused"} or self._has_active_worker():
                raise ClientError("処理中はモザイク候補をクリアできません。")
            self._clear_masks_unchecked(records)
        return len(records)

    def _clear_masks_unchecked(self, records: list[ImageRecord]) -> None:
        for record in records:
            candidates = list(self.candidates.get(record.image_id, []))
            for candidate in candidates:
                try:
                    candidate.mask_path.unlink(missing_ok=True)
                except OSError as exc:
                    LOGGER.warning("Could not remove stale mask %s: %s", candidate.mask_path, exc)
            self.candidates[record.image_id] = []
            self._touch_candidates(record.image_id)
            candidate_dir = self.cache_dir / record.image_id
            try:
                if candidate_dir.exists():
                    for mask_path in candidate_dir.glob("*.png"):
                        mask_path.unlink(missing_ok=True)
            except OSError as exc:
                LOGGER.warning("Could not clear stale mask directory %s: %s", candidate_dir, exc)

    def _cleanup_record_working_state_unchecked(self, record: ImageRecord, *, remove_session_source: bool) -> None:
        """Remove this image's disposable cache state without touching external sources."""
        self._clear_masks_unchecked([record])
        shutil.rmtree(self.cache_dir / record.image_id, ignore_errors=True)
        thumbnail_dir = self.cache_dir / "thumbnails"
        for thumbnail_path in thumbnail_dir.glob(f"{record.image_id}-*.jpg"):
            thumbnail_path.unlink(missing_ok=True)
        self._discard_browser_save_tokens_for_image_unchecked(record.image_id)
        if remove_session_source and record.source_kind == "session":
            try:
                record.path.unlink(missing_ok=True)
            except PermissionError as exc:
                LOGGER.warning("Session source will be cleaned up at shutdown: %s", exc)
            imports_dir = self.session_imports_dir
            if imports_dir is not None:
                parent = record.path.parent
                while parent != imports_dir and parent.is_relative_to(imports_dir):
                    try:
                        parent.rmdir()
                    except OSError:
                        break
                    parent = parent.parent

    def import_images(self, files: list[dict[str, Any]]) -> list[dict[str, Any]]:
        images, _imported = self._import_images(files)
        return images

    def import_images_for_api(self, files: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
        if not isinstance(files, list) or any(not isinstance(item, dict) or not isinstance(item.get("clientKey"), str) or not item["clientKey"] for item in files):
            raise ClientError("追加画像のclientKeyが不正です。")
        return self._import_images(files)

    def _import_images(
        self,
        files: list[dict[str, Any]],
        *,
        include_images: bool = True,
    ) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
        if not isinstance(files, list) or not files:
            raise ClientError("追加する画像がありません。")

        with self.lock:
            root = self.root
            catalog_generation = self.catalog_generation
            if self.job.state in {"running", "paused"} or self._has_active_worker():
                raise ClientError("処理中は画像を追加できません。")
            destination_dir = self._ensure_session()
            self.importing_count += 1

        pending: list[tuple[Path, str, int, int, str]] = []
        try:
            # Decoding and staging can overlap across request threads. The short
            # catalogue commit below remains serialized.
            for file_data in files:
                if not isinstance(file_data, dict):
                    raise ClientError("画像データの形式が正しくありません。")
                client_key = str(file_data.get("clientKey") or uuid.uuid4().hex)
                relative_path = safe_import_relative_path(file_data.get("relativePath", file_data.get("name", "")))
                if relative_path.suffix.lower() not in IMAGE_SUFFIXES:
                    continue
                raw_value = file_data.get("raw")
                if isinstance(raw_value, bytes):
                    raw = raw_value
                else:
                    try:
                        raw = base64.b64decode(str(file_data.get("data", "")), validate=True)
                    except (binascii.Error, ValueError) as exc:
                        raise ClientError("追加画像を読み込めません。") from exc
                if not raw:
                    continue
                _verify_decodable_image(raw)
                with Image.open(io.BytesIO(raw)) as image:
                    _assert_image_suffix_matches_format(relative_path.suffix, image.format)
                    width, height = oriented_image_size(image)
                temporary = destination_dir / f".mozarie-import-{uuid.uuid4().hex}.tmp"
                temporary.write_bytes(raw)
                pending.append((temporary, relative_path.as_posix(), width, height, client_key))

            with self.import_lock, self.lock:
                if (
                    self.root != root
                    or self.catalog_generation != catalog_generation
                    or self.job.state in {"running", "paused"}
                    or self._has_active_worker()
                ):
                    raise ClientError("画像一覧が更新されたため、画像の追加を中止しました。もう一度追加してください。")
                added: list[ImageRecord] = []
                final_paths: list[Path] = []
                try:
                    imported: list[dict[str, str]] = []
                    for temporary, name, width, height, client_key in pending:
                        destination = unique_session_import_destination(destination_dir / name)
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        os.replace(temporary, destination)
                        final_paths.append(destination)
                        stat = destination.stat()
                        image_id = uuid.uuid4().hex
                        added.append(ImageRecord(
                            image_id,
                            destination,
                            destination.relative_to(destination_dir).as_posix(),
                            width,
                            height,
                            stat.st_mtime_ns,
                            stat.st_size,
                            "session",
                        ))
                        imported.append({"clientKey": client_key, "imageId": image_id})
                except Exception:
                    for destination in final_paths:
                        destination.unlink(missing_ok=True)
                    raise
                for record in added:
                    self.images[record.image_id] = record
                    self.order.append(record.image_id)
                self.order.sort(key=lambda image_id: self.images[image_id].relative_path.lower())
                images = self.list_images() if include_images else []
                return images, imported
        finally:
            for temporary, _name, _width, _height, _client_key in pending:
                temporary.unlink(missing_ok=True)
            with self.lock:
                self.importing_count -= 1

    def import_image_bytes_for_api(
        self,
        raw: bytes,
        *,
        name: str,
        relative_path: str,
        client_key: str,
        include_images: bool = True,
    ) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
        if not isinstance(client_key, str) or not client_key:
            raise ClientError("追加画像のclientKeyが不正です。")
        return self._import_images([{
            "clientKey": client_key,
            "name": name,
            "relativePath": relative_path,
            "raw": raw,
        }], include_images=include_images)

    def _clear_cache(self) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        for child in self.cache_dir.iterdir():
            if child.name == ".active.lock":
                continue
            try:
                if child.is_dir():
                    shutil.rmtree(child)
                else:
                    child.unlink()
            except OSError as exc:
                LOGGER.warning("Could not clear cache entry %s: %s", child, exc)

    def _invalidate_sam_cache(self) -> None:
        with self.sam_lock:
            self.sam_image_id = None

    def invalidate_sam_image(self, image_id: str) -> None:
        with self.sam_lock:
            if self.sam_image_id == image_id:
                self.sam_image_id = None

    def _sam_predictor_for(self, record: ImageRecord) -> Any:
        with self.sam_lock:
            if self.sam_predictor is None:
                sam_path = self._configured_sam_path()
                try:
                    from segment_anything import SamPredictor, sam_model_registry
                except ImportError as exc:
                    raise ClientError("SAMのPythonパッケージを読み込めません。") from exc
                model_type = self.settings["models"]["sam_model_type"]
                provider = self.settings["models"]["provider"]
                if provider == "gpu" and not torch_module().cuda.is_available():
                    raise ClientError("SAMをGPUで実行できません。CPUを選ぶかCUDA環境を確認してください。", "sam_provider_unavailable")
                model = sam_model_registry[model_type](checkpoint=str(sam_path))
                device = f"cuda:{int(self.settings['models'].get('gpu_device', 0))}" if provider == "gpu" else "cpu"
                model.to(device=device)
                self.sam_predictor = SamPredictor(model)

            if self.sam_image_id != record.image_id:
                with Image.open(record.path) as image:
                    self.sam_predictor.set_image(np.asarray(ImageOps.exif_transpose(image).convert("RGB")))
                self.sam_image_id = record.image_id
            return self.sam_predictor

    @staticmethod
    def _allowed_root_for_record(
        record: ImageRecord,
        root: Path | None,
        session_imports_dir: Path | None,
    ) -> Path | None:
        if record.source_kind == "filesystem":
            return root
        if record.source_kind == "session":
            return session_imports_dir
        return None

    def image_for_id(self, image_id: str) -> ImageRecord:
        with self.lock:
            record = self.images.get(image_id)
            root = self.root
            session_imports_dir = self.session_imports_dir
        if record is None:
            raise ClientError("画像が見つかりません。フォルダを再読込してください。")
        try:
            allowed_root = self._allowed_root_for_record(record, root, session_imports_dir)
            if allowed_root is None:
                raise ValueError
            record.path.resolve().relative_to(allowed_root.resolve())
        except ValueError as exc:
            raise ClientError("許可されていない画像パスです。") from exc
        if not record.path.is_file():
            raise ClientError("画像ファイルが見つかりません。")
        self._assert_record_fresh(record)
        return record

    def list_images(self) -> list[dict[str, Any]]:
        with self.lock:
            output = []
            for image_id in self.order:
                record = self.images[image_id]
                output.append(
                    {
                        "id": record.image_id,
                        "relativePath": record.relative_path,
                        "sourceKind": record.source_kind,
                        "width": record.width,
                        "height": record.height,
                        "mtimeNs": record.mtime_ns,
                        "contentVersion": record.content_version,
                        "candidateCount": len(self.candidates.get(image_id, [])),
                        "enabledCandidateCount": sum(
                            candidate.enabled and candidate.role == CandidateRole.APPLY
                            for candidate in self.candidates.get(image_id, [])
                        ),
                        "candidateRevision": self._candidate_revision(image_id),
                    }
                )
            return output

    def list_candidates(self, image_id: str) -> list[dict[str, Any]]:
        self.image_for_id(image_id)
        with self.lock:
            stored_candidates = self.candidates.get(image_id, [])
            candidates = [candidate for candidate in stored_candidates if candidate.mask_path.is_file()]
            if len(candidates) != len(stored_candidates):
                self._touch_candidates(image_id)
            self.candidates[image_id] = candidates
        return [
            candidate.as_api_dict(
                SOURCE_LABELS.get(candidate.source, candidate.source),
                REFINEMENT_LABELS.get(candidate.refinement or "", ""),
            )
            for candidate in candidates
        ]

    def _remove_candidate_unchecked(self, image_id: str, candidate_id: str) -> None:
        candidates = self.candidates.get(image_id, [])
        self.candidates[image_id] = [candidate for candidate in candidates if candidate.candidate_id != candidate_id]

    def read_candidate_mask_png(self, image_id: str, candidate_id: str) -> bytes:
        """Read a mask while retaining the state lock so cleanup cannot unlink it."""
        with self.lock:
            candidate = next(
                (candidate for candidate in self.candidates.get(image_id, []) if candidate.candidate_id == candidate_id),
                None,
            )
            if candidate is None:
                raise StaleMaskError("検出候補は既に更新されています。")
            try:
                with Image.open(candidate.mask_path) as mask_image:
                    alpha = mask_image.convert("L")
                    rgba = Image.new("RGBA", alpha.size, (255, 255, 255, 0))
                    rgba.putalpha(alpha)
                    output = io.BytesIO()
                    rgba.save(output, format="PNG")
                    return output.getvalue()
            except FileNotFoundError as exc:
                self._remove_candidate_unchecked(image_id, candidate_id)
                self._touch_candidates(image_id)
                raise StaleMaskError("検出候補は既に更新されています。") from exc

    def set_candidate_state(self, image_id: str, candidate_id: str, payload: dict[str, Any]) -> int:
        self.image_for_id(image_id)
        with self.lock:
            if self._has_active_worker():
                raise ClientError("バックグラウンド処理中は候補を変更できません。")
            candidate = next(
                (candidate for candidate in self.candidates.get(image_id, []) if candidate.candidate_id == candidate_id),
                None,
            )
            if candidate is None:
                raise ClientError("検出候補が見つかりません。")
            if "enabled" in payload:
                if not isinstance(payload["enabled"], bool):
                    raise ClientError("候補のON/OFFは真偽値で指定してください。")
                candidate.enabled = payload["enabled"]
            if "color" in payload:
                color = str(payload["color"])
                if not _valid_color(color):
                    raise ClientError("色の形式が正しくありません。")
                candidate.color = color
            self._touch_candidates(image_id)
            return self._candidate_revision(image_id)

    def batch_update_candidates(self, image_id: str, payload: dict[str, Any]) -> int:
        """Apply one simple bulk operation and advance the revision once."""
        self.image_for_id(image_id)
        role = payload.get("role")
        operation = payload.get("operation")
        if role not in {"apply", "exclude"} or operation not in {"enable", "disable", "delete"}:
            raise ClientError("候補の一括操作が正しくありません。")
        with self.lock:
            if self._has_active_worker():
                raise ClientError("バックグラウンド処理中は候補を変更できません。")
            selected = [item for item in self.candidates.get(image_id, []) if item.role.value == role]
            if operation == "delete":
                for item in selected:
                    try:
                        item.mask_path.unlink(missing_ok=True)
                    except OSError:
                        pass
                self.candidates[image_id] = [item for item in self.candidates.get(image_id, []) if item not in selected]
            else:
                for item in selected:
                    item.enabled = operation == "enable"
            return self._touch_candidates(image_id)

    def delete_candidate(self, image_id: str, candidate_id: str) -> bool:
        self.image_for_id(image_id)
        with self.lock:
            if self._has_active_worker():
                raise ClientError("バックグラウンド処理中は候補を変更できません。")
            candidates = self.candidates.get(image_id, [])
            candidate = next((item for item in candidates if item.candidate_id == candidate_id), None)
            if candidate is None:
                return False
            candidate.mask_path.unlink(missing_ok=True)
            self.candidates[image_id] = [item for item in candidates if item.candidate_id != candidate_id]
            self._touch_candidates(image_id)
            return True

