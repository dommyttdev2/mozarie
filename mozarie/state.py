from .core import *
from .core import _read_detection_parallelism, _read_mosaic_divisor, _read_save_suffix, _read_target_classes
from .image_io import *
from . import image_io as _image_io
from .image_io import _default_output_destination

globals().update({name: value for name, value in vars(_image_io).items() if not name.startswith("__")})


@dataclass
class DetectionModels:
    target: TargetSegmenter
    auxiliaries: list[tuple[str, GenericYoloSegmenter]] = field(default_factory=list)
    hand: HandDetector | None = None


class StudioState:
    def __init__(self, cache_dir: Path | None = None, session_base_dir: Path | None = None) -> None:
        self.settings_store = SettingsStore(APP_DIR)
        self.settings = self.settings_store.load()
        self.lock = threading.RLock()
        self.import_lock = threading.Lock()
        self.importing_count = 0
        self._cache_lock_handle: Any | None = None
        self._owns_process_cache = cache_dir is None
        if cache_dir is None:
            self._cleanup_stale_process_caches()
            self.cache_dir = CACHE_BASE_DIR / f"process-{os.getpid()}-{uuid.uuid4().hex}"
            self.cache_dir.mkdir(parents=True, exist_ok=False)
            self._cache_lock_handle = self._lock_directory(self.cache_dir)
        else:
            self.cache_dir = Path(cache_dir)
        self.session_base_dir = Path(session_base_dir) if session_base_dir is not None else SESSION_BASE_DIR
        self.session_dir: Path | None = None
        self.session_imports_dir: Path | None = None
        self._session_lock_handle: Any | None = None
        self.root: Path | None = None
        self.images: dict[str, ImageRecord] = {}
        self.order: list[str] = []
        self.candidates: dict[str, list[Candidate]] = {}
        self.candidate_revisions: dict[str, int] = {}
        self.browser_save_tokens: dict[str, BrowserSaveToken] = {}
        self.browser_save_receipts: dict[str, BrowserSaveReceipt] = {}
        self.session_token = secrets.token_urlsafe(32)
        self.job = Job()
        self.catalog_generation = 0
        self.job_generation = 0
        self.worker_thread: threading.Thread | None = None
        self.job_control: JobControl | None = None
        self.models: DetectionModels | None = None
        self.sam_predictor: Any | None = None
        self.sam_image_id: str | None = None
        self.sam_lock = threading.RLock()
        self.inference_lock = threading.Lock()
        self._detection_target_classes: dict[int, set[str]] = {}
        self._cleanup_stale_sessions()

    def update_settings(self, update: dict[str, Any]) -> dict[str, Any]:
        """Persist user-selected options and release only model objects that changed."""
        if not isinstance(update, dict):
            raise ClientError("設定の形式が正しくありません。", "invalid_settings")
        with self.lock:
            if self._has_active_worker():
                raise ClientError("処理中は設定を変更できません。", "job_running")
            previous_models = dict(self.settings.get("models", {}))
            try:
                settings = self.settings_store.save(update)
            except SettingsError as exc:
                raise ClientError("設定の内容が正しくありません。", "invalid_settings", {"detail": str(exc)}) from exc
            self.settings = settings
            detection_keys = {
                "target_segmentation", "ntd11", "ntd11_enabled", "sensitive", "sensitive_enabled",
                "hand_detection", "hand_detection_enabled", "provider", "gpu_device",
            }
            sam_keys = {"sam_checkpoint", "sam_model_type", "provider", "gpu_device"}
            if any(settings["models"].get(key) != previous_models.get(key) for key in detection_keys):
                self.models = None
            if any(settings["models"].get(key) != previous_models.get(key) for key in sam_keys):
                self.sam_predictor = None
                self.sam_image_id = None
            return self.settings

    def reset_settings(self) -> dict[str, Any]:
        with self.lock:
            if self._has_active_worker():
                raise ClientError("処理中は設定を変更できません。", "job_running")
            self.settings = self.settings_store.reset()
            self.models = None
            self.sam_predictor = None
            self.sam_image_id = None
            return self.settings

    def settings_status(self) -> dict[str, Any]:
        """Report model compatibility without constructing inference sessions."""
        models = self.settings["models"]
        result: dict[str, dict[str, Any]] = {}
        validators = {
            "target_segmentation": validate_target_profile,
            "ntd11": validate_generic_yolo_segment_profile,
            "sensitive": validate_generic_yolo_segment_profile,
            "hand_detection": validate_hand_profile,
        }

        def add_status(key: str, *, required: bool, enabled: bool, required_suffix: str | None = None) -> None:
            raw = str(models.get(key, "")).strip()
            if not required and not enabled:
                result[key] = {
                    "required": False,
                    "enabled": False,
                    "configured": bool(raw),
                    "exists": False,
                    "valid": False,
                    "detail": "",
                    "profile": None,
                }
                return
            path = Path(raw).expanduser() if raw else None
            exists = bool(path and path.is_file())
            valid = exists and (required_suffix is None or path.suffix.lower() == required_suffix)
            detail = ""
            profile: dict[str, object] | None = None
            if valid and key in validators:
                try:
                    profile = profile_summary(validators[key](path))
                except ModelProfileError as exc:
                    valid = False
                    detail = str(exc)
            if valid and key == "sam_checkpoint" and path.suffix.lower() not in {".pth", ".pt", ".ckpt"}:
                valid = False
                detail = "SAMチェックポイントは .pth、.pt、.ckpt のいずれかを指定してください"
            result[key] = {
                "required": required,
                "enabled": enabled,
                "configured": bool(raw),
                "exists": exists,
                "valid": valid,
                "detail": detail,
                "profile": profile,
            }

        add_status("target_segmentation", required=True, enabled=True, required_suffix=".onnx")
        add_status("ntd11", required=False, enabled=bool(models["ntd11_enabled"]), required_suffix=".onnx")
        add_status("sensitive", required=False, enabled=bool(models["sensitive_enabled"]), required_suffix=".onnx")
        add_status("hand_detection", required=False, enabled=bool(models["hand_detection_enabled"]), required_suffix=".onnx")
        add_status("sam_checkpoint", required=True, enabled=True)
        gpus = []
        if torch_module().cuda.is_available():
            for index in range(torch_module().cuda.device_count()):
                gpus.append({"id": index, "name": torch_module().cuda.get_device_name(index)})
        return {
            "models": result,
            "provider": models["provider"],
            "samModelType": models["sam_model_type"],
            "gpus": gpus,
            "gpuDevice": models.get("gpu_device", 0),
        }

    @staticmethod
    def _lock_directory(directory: Path) -> Any:
        lock_handle = (directory / ".active.lock").open("w+b")
        try:
            lock_handle.write(b"1")
            lock_handle.flush()
            lock_handle.seek(0)
            msvcrt.locking(lock_handle.fileno(), msvcrt.LK_NBLCK, 1)
            return lock_handle
        except Exception:
            lock_handle.close()
            raise

    @staticmethod
    def _release_directory_lock(lock_handle: Any | None) -> None:
        if lock_handle is None:
            return
        try:
            lock_handle.seek(0)
            msvcrt.locking(lock_handle.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            pass
        lock_handle.close()

    @classmethod
    def _cleanup_stale_process_caches(cls) -> None:
        if not CACHE_BASE_DIR.is_dir():
            return
        cutoff = time.time() - 60
        for cache_dir in CACHE_BASE_DIR.glob("process-*"):
            if not cache_dir.is_dir():
                continue
            lock_path = cache_dir / ".active.lock"
            try:
                if not lock_path.exists():
                    if cache_dir.stat().st_mtime > cutoff:
                        continue
                    shutil.rmtree(cache_dir, ignore_errors=True)
                    continue
                with lock_path.open("a+b") as handle:
                    handle.seek(0)
                    try:
                        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    except OSError:
                        continue
                    try:
                        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                    except OSError:
                        pass
                shutil.rmtree(cache_dir, ignore_errors=True)
            except OSError:
                continue

    def _cleanup_stale_sessions(self) -> None:
        """Remove abandoned import sessions without touching a live instance."""
        if not self.session_base_dir.is_dir():
            return
        cutoff = time.time() - 60
        for session_dir in self.session_base_dir.glob("session-*"):
            try:
                if not session_dir.is_dir():
                    continue
                lock_path = session_dir / ".active.lock"
                if not lock_path.exists():
                    if session_dir.stat().st_mtime > cutoff:
                        continue
                    shutil.rmtree(session_dir, ignore_errors=True)
                    continue
                with lock_path.open("a+b") as handle:
                    handle.seek(0)
                    try:
                        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                    except OSError:
                        continue
                    try:
                        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                    except OSError:
                        pass
                shutil.rmtree(session_dir, ignore_errors=True)
            except OSError:
                continue

    def _ensure_session(self) -> Path:
        if self.session_imports_dir is not None:
            return self.session_imports_dir
        self.session_base_dir.mkdir(parents=True, exist_ok=True)
        session_dir = self.session_base_dir / f"session-{uuid.uuid4().hex}"
        imports_dir = session_dir / "imports"
        imports_dir.mkdir(parents=True)
        lock_handle = (session_dir / ".active.lock").open("w+b")
        try:
            lock_handle.write(b"1")
            lock_handle.flush()
            lock_handle.seek(0)
            msvcrt.locking(lock_handle.fileno(), msvcrt.LK_NBLCK, 1)
        except Exception:
            lock_handle.close()
            shutil.rmtree(session_dir, ignore_errors=True)
            raise
        self.session_dir = session_dir
        self.session_imports_dir = imports_dir
        self._session_lock_handle = lock_handle
        return imports_dir

    def _clear_session_unchecked(self) -> None:
        session_dir = self.session_dir
        lock_handle = self._session_lock_handle
        self.session_dir = None
        self.session_imports_dir = None
        self._session_lock_handle = None
        if lock_handle is not None:
            try:
                lock_handle.seek(0)
                msvcrt.locking(lock_handle.fileno(), msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
            lock_handle.close()
        if session_dir is not None:
            shutil.rmtree(session_dir, ignore_errors=True)

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

    def start_detection(
        self,
        image_ids: list[str],
        confidence: float = DEFAULT_DETECTION_CONFIDENCE,
        parallelism: int = 2,
        target_classes: set[str] | None = None,
    ) -> None:
        records, catalog_generation = self._records_for_ids_with_catalog(image_ids)
        targets = _read_target_classes(target_classes or set(self.settings["detection"]["targets"]))
        args: tuple[Any, ...] = (confidence, _read_detection_parallelism(parallelism))
        if targets != TARGET_CLASSES:
            args = (*args, targets)
        self._start_job("detect", records, self._detect_worker, *args, expected_catalog_generation=catalog_generation)

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

    def _load_detection_models(self) -> DetectionModels:
        model_path = self._configured_model_path("target_segmentation", "対象セグメンテーション")
        provider = str(self.settings["models"].get("provider", "gpu"))
        gpu_device = int(self.settings["models"].get("gpu_device", 0))
        if provider == "gpu":
            assert_onnx_cuda_available()
        target = TargetSegmenter(model_path, device=provider, gpu_device=gpu_device)
        auxiliaries: list[tuple[str, GenericYoloSegmenter]] = []
        for key, label in (("ntd11", "NTD11補助モデル"), ("sensitive", "Sensitive補助モデル")):
            if not self.settings["models"][f"{key}_enabled"]:
                continue
            auxiliaries.append((key, GenericYoloSegmenter(self._configured_model_path(key, label), device=provider, gpu_device=gpu_device)))
        return DetectionModels(target=target, auxiliaries=auxiliaries)

    def _configured_model_path(self, key: str, label: str) -> Path:
        raw_path = str(self.settings.get("models", {}).get(key, "")).strip()
        if not raw_path:
            raise ClientError(f"{label}モデルが未設定です。設定のモデルタブでONNXファイルを指定してください。")
        path = Path(raw_path).expanduser()
        if not path.is_file():
            raise ClientError(f"{label}モデルが見つかりません: {path}")
        if path.suffix.lower() != ".onnx":
            raise ClientError(f"{label}モデルにはONNXファイルを指定してください。")
        try:
            {
                "target_segmentation": validate_target_profile,
                "ntd11": validate_generic_yolo_segment_profile,
                "sensitive": validate_generic_yolo_segment_profile,
                "hand_detection": validate_hand_profile,
            }[key](path)
        except ModelProfileError as exc:
            raise ClientError(f"{label}モデルの互換プロファイルが一致しません: {exc}", "model_profile_invalid") from exc
        return path

    def _configured_sam_path(self) -> Path:
        raw_path = str(self.settings.get("models", {}).get("sam_checkpoint", "")).strip()
        if not raw_path:
            raise ClientError("SAMモデルが未設定です。設定のモデルタブでチェックポイントを指定してください。")
        path = Path(raw_path).expanduser()
        if not path.is_file():
            raise ClientError(f"SAMモデルが見つかりません: {path}")
        if path.suffix.lower() not in {".pth", ".pt", ".ckpt"}:
            raise ClientError("SAMチェックポイントは .pth、.pt、.ckpt のいずれかを指定してください。", "sam_checkpoint_invalid")
        return path

    def _ensure_models(self) -> DetectionModels:
        with self.lock:
            if self.models is not None:
                return self.models
        models = self._load_detection_models()
        with self.lock:
            self.models = models
        return models

    def _ensure_hand_model(self, models: DetectionModels) -> HandDetector:
        if models.hand is not None:
            return models.hand
        model_path = self._configured_model_path("hand_detection", "手の検出")
        provider = str(self.settings["models"].get("provider", "gpu"))
        if provider == "gpu":
            assert_onnx_cuda_available()
        models.hand = HandDetector(model_path, device=provider, gpu_device=int(self.settings["models"].get("gpu_device", 0)))
        return models.hand

    def _detect_worker(
        self,
        records: list[ImageRecord],
        confidence: float,
        parallelism: int = 2,
        target_classes: set[str] | None = None,
        *,
        control: JobControl | None = None,
        job_generation: int | None = None,
        catalog_generation: int | None = None,
    ) -> None:
        try:
            mode = str(self.settings["detection"]["mode"])
            worker_count = min(_read_detection_parallelism(parallelism), len(records))
            model_slots = [self._ensure_models(), *(self._load_detection_models() for _ in range(worker_count - 1))]
            groups = [records[index::worker_count] for index in range(worker_count)]
            with self.lock:
                if self._job_is_current(job_generation, catalog_generation):
                    self.job.active_count = worker_count

            def run_slot(models: DetectionModels, assigned: list[ImageRecord]) -> None:
                for record in assigned:
                    if not self._job_is_current(job_generation, catalog_generation):
                        return
                    if control is not None and control.cancel_requested.is_set():
                        return
                    self._wait_while_paused(control, job_generation, catalog_generation)
                    if control is not None and control.cancel_requested.is_set():
                        return
                    self._set_job_current(record.relative_path, job_generation, catalog_generation)
                    try:
                        self._detection_target_classes[id(models)] = target_classes or TARGET_CLASSES
                        candidates = self._detect_image(models, record, confidence, mode)
                    except RuntimeError as exc:
                        if "out of memory" in str(exc).lower():
                            if control is not None:
                                control.cancel_requested.set()
                            raise ClientError("GPUメモリが不足しました。並列数を下げてください。") from exc
                        raise
                    if control is not None and control.cancel_requested.is_set():
                        self._discard_candidates(candidates)
                        return
                    with self.lock:
                        if (control is not None and control.cancel_requested.is_set()) or not self._job_is_current(job_generation, catalog_generation):
                            self._discard_candidates(candidates)
                            return
                        boundary_candidates = [
                            candidate for candidate in self.candidates.get(record.image_id, [])
                            if candidate.origin == "boundary"
                        ]
                        for candidate in self.candidates.get(record.image_id, []):
                            if candidate.origin != "boundary":
                                candidate.mask_path.unlink(missing_ok=True)
                        self.candidates[record.image_id] = [*boundary_candidates, *candidates]
                        self._touch_candidates(record.image_id)
                        self._mark_image_completed(record.image_id, job_generation, catalog_generation)
                        self._set_job_current(record.relative_path, job_generation, catalog_generation)

            with ThreadPoolExecutor(max_workers=worker_count, thread_name_prefix="MosaicDetect") as executor:
                futures = [executor.submit(run_slot, models, group) for models, group in zip(model_slots, groups) if group]
                wait(futures)
                for future in futures:
                    future.result()
            if control is not None and control.cancel_requested.is_set():
                self._cancel_job(job_generation, catalog_generation)
                return
            self._finish_job(job_generation, catalog_generation)
        except Exception as exc:  # A background job must not kill the HTTP server.
            self._fail_job(exc, job_generation, catalog_generation)

    def _discard_candidates(self, candidates: list[Candidate]) -> None:
        for candidate in candidates:
            candidate.mask_path.unlink(missing_ok=True)

    def _detect_arbitrated_segments(
        self, models: DetectionModels, rgb: Image.Image, confidence: float, target_classes: set[str] | None = None
    ) -> list[dict[str, Any]]:
        width, height = rgb.size
        targets = target_classes or TARGET_CLASSES
        segments = (models.target.detect(np.asarray(rgb), confidence) if targets == TARGET_CLASSES
                    else models.target.detect(np.asarray(rgb), confidence, targets))
        collected = [segment for segment in segments if segment["mask"].shape == (height, width)]
        for source, model in models.auxiliaries:
            tiled_segments: list[dict[str, Any]] = []
            for x_offset, y_offset, tile_width, tile_height in detection_tiles(width, height):
                tile = np.asarray(rgb.crop((x_offset, y_offset, x_offset + tile_width, y_offset + tile_height)))
                if targets == TARGET_CLASSES:
                    detected_segments = model.detect(tile, confidence_for_source(source, confidence), source)
                else:
                    detected_segments = model.detect(tile, confidence_for_source(source, confidence), source, targets)
                for segment in detected_segments:
                    local_mask = np.asarray(segment["mask"], dtype=np.uint8)
                    if local_mask.shape != (tile_height, tile_width):
                        continue
                    merge_segment(
                        tiled_segments,
                        str(segment["class_name"]),
                        float(segment["confidence"]),
                        restore_tile_mask(local_mask, width, height, x_offset, y_offset),
                        source,
                    )
            collected.extend(tiled_segments)
        return arbitrate_segment_sources(collected)

    def _hand_boxes(self, models: DetectionModels, rgb: Image.Image) -> list[tuple[int, int, int, int]]:
        if not self.settings["models"]["hand_detection_enabled"]:
            return []
        hand_model = self._ensure_hand_model(models)
        return hand_model.detect_boxes(np.asarray(rgb), HAND_CONFIDENCE)

    @staticmethod
    def _box_intersects_mask(box: tuple[int, int, int, int], mask: np.ndarray) -> bool:
        left, top, right, bottom = box
        height, width = mask.shape[:2]
        left, right = max(0, left), min(width, right)
        top, bottom = max(0, top), min(height, bottom)
        return left < right and top < bottom and bool(np.any(mask[top:bottom, left:right] > 0))

    def _refine_detected_segments(
        self, models: DetectionModels, record: ImageRecord, rgb: Image.Image, segments: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        detected = [segment for segment in segments if segment["class_name"] in TARGET_CLASSES]
        if not detected:
            return segments
        genital_mask = np.zeros_like(detected[0]["mask"], dtype=np.uint8)
        for segment in detected:
            genital_mask = np.maximum(genital_mask, segment["mask"])
        hand_boxes = self._hand_boxes(models, rgb)
        intersecting_boxes = [box for box in hand_boxes if self._box_intersects_mask(box, genital_mask)]
        if not intersecting_boxes:
            hand_mask = np.zeros_like(genital_mask, dtype=np.uint8)
        else:
            hand_mask = np.zeros_like(genital_mask, dtype=np.uint8)
            # SAM caches one current image, so set_image and every predictor call share one lock.
            with self.sam_lock:
                predictor = self._sam_predictor_for(record)
                for box in intersecting_boxes:
                    padded_box = padded_hand_box(box, genital_mask.shape[:2])
                    if padded_box is None:
                        continue
                    masks, scores, _ = predictor.predict(
                        point_coords=None,
                        point_labels=None,
                        box=np.asarray(padded_box, dtype=np.float32),
                        multimask_output=True,
                    )
                    confirmed = accepted_hand_sam_mask(masks, scores, genital_mask.shape[:2], padded_box)
                    if confirmed is not None:
                        hand_mask = np.maximum(hand_mask, confirmed)

        for segment in detected:
            original_mask = np.asarray(segment["mask"]).copy()
            refined, decision = refine_mask_with_hand(segment["mask"], hand_mask)
            hand_exclusion = ((original_mask > 0) & (np.asarray(refined) == 0)).astype(np.uint8) * 255
            exclusions: dict[str, np.ndarray] = {}
            if decision == "refined":
                segment["mask"] = refined
                segment["refinement"] = "hand"
            if np.any(hand_exclusion):
                exclusions["hand"] = hand_exclusion
            if segment["class_name"] != "penis":
                segment["exclusions"] = exclusions
                continue
            if self.settings["detection"]["fluid_exclusion_enabled"]:
                fluid_mask = white_fluid_mask(rgb, segment["mask"])
                if np.any(fluid_mask):
                    before_fluid = np.asarray(segment["mask"]).copy()
                    segment["mask"] = np.where(fluid_mask > 0, 0, before_fluid).astype(np.uint8)
                    exclusions["fluid"] = ((before_fluid > 0) & (segment["mask"] == 0)).astype(np.uint8) * 255
                    segment["refinement"] = "hand_fluid" if segment.get("refinement") == "hand" else "fluid"
            segment["exclusions"] = exclusions
        return segments

    def _high_precision_segments(
        self, models: DetectionModels, record: ImageRecord, segments: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Refine each detector region once with SAM, keeping the detector result on weak matches."""
        del models  # The refinement is intentionally model-independent after target detection.
        if not segments:
            return segments
        with self.sam_lock:
            predictor = self._sam_predictor_for(record)
            for segment in segments:
                source_mask = (np.asarray(segment["mask"]) > 0).astype(np.uint8)
                points = np.argwhere(source_mask > 0)
                if not len(points):
                    continue
                top, left = points.min(axis=0)
                bottom, right = points.max(axis=0) + 1
                height, width = source_mask.shape
                padding = max(2, int(max(bottom - top, right - left) * 0.05))
                roi = (max(0, int(left - padding)), max(0, int(top - padding)),
                       min(width, int(right + padding)), min(height, int(bottom + padding)))
                distances = cv2.distanceTransform(source_mask, cv2.DIST_L2, 3)
                y, x = np.unravel_index(int(np.argmax(distances)), distances.shape)
                masks, scores, _ = predictor.predict(
                    point_coords=np.asarray([[x, y]], dtype=np.float32),
                    point_labels=np.asarray([1], dtype=np.int32),
                    box=np.asarray(roi, dtype=np.float32),
                    multimask_output=True,
                )
                refined, _score = select_best_sam_mask(masks, scores)
                refined = clip_mask_to_roi(refined, roi)
                overlap = mask_iou(source_mask, refined)
                source_area = int(np.count_nonzero(source_mask))
                refined_area = int(np.count_nonzero(refined))
                if overlap < 0.20 or refined_area < max(8, source_area // 4) or refined_area > source_area * 3:
                    segment["refinement"] = "sam_fallback"
                    continue
                segment["mask"] = refined
                segment["refinement"] = "sam_high_precision"
        return segments

    def _detect_image(
        self, models: DetectionModels, record: ImageRecord, confidence: float, mode: str | None = None,
        target_classes: set[str] | None = None,
    ) -> list[Candidate]:
        self._assert_record_fresh(record)
        with Image.open(record.path) as image:
            rgb = ImageOps.exif_transpose(image).convert("RGB")
        segments = self._detect_arbitrated_segments(models, rgb, confidence, target_classes or self._detection_target_classes.get(id(models), TARGET_CLASSES))
        if mode == "high_precision":
            segments = self._high_precision_segments(models, record, segments)
        original_masks = {id(segment): np.asarray(segment["mask"]).copy() for segment in segments}
        segments = self._refine_detected_segments(models, record, rgb, segments)
        candidates: list[Candidate] = []
        destination = self.cache_dir / record.image_id
        destination.mkdir(parents=True, exist_ok=True)
        for segment in segments:
            refined_mask = np.asarray(segment["mask"]).copy()
            original_mask = np.asarray(original_masks.get(id(segment), refined_mask)).copy()
            # Keep the detector/SAM mask intact.  Hands and fluid are separate
            # exclusion candidates, so their checkbox can genuinely restore the
            # underlying target mask when turned off.
            segment["mask"] = original_mask
            candidate_id = uuid.uuid4().hex
            mask_path = destination / f"{candidate_id}.png"
            Image.fromarray(segment["mask"], mode="L").save(mask_path, format="PNG")
            candidates.append(
                Candidate(
                    candidate_id=candidate_id,
                    class_name=segment["class_name"],
                    confidence=segment["confidence"],
                    mask_path=mask_path,
                    color=DEFAULT_COLORS.get(segment["class_name"], "#5bb6d5"),
                    source=segment["source"],
                    refinement=segment.get("refinement"),
                )
            )
            for exclusion_kind, exclusion_mask in dict(segment.get("exclusions", {})).items():
                if not np.any(exclusion_mask):
                    continue
                exclusion_source = f"{exclusion_kind}_exclusion"
                exclusion_id = uuid.uuid4().hex
                exclusion_path = destination / f"{exclusion_id}.png"
                Image.fromarray(exclusion_mask, mode="L").save(exclusion_path, format="PNG")
                candidates.append(Candidate(
                    candidate_id=exclusion_id,
                    class_name=SOURCE_LABELS[exclusion_source],
                    confidence=None,
                    mask_path=exclusion_path,
                    color="#4ac3df",
                    source=exclusion_source,
                    origin="auto",
                    role=CandidateRole.EXCLUDE,
                ))
        return candidates

    def add_boundary_candidate(self, image_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        record = self.image_for_id(image_id)
        polygon_mask: np.ndarray | None = None
        if "points" in payload:
            roi, point, polygon_mask = read_polygon_boundary_request(payload, record.width, record.height)
        else:
            roi, point = read_boundary_request(payload, record.width, record.height)
        with self.inference_lock:
            with self.lock:
                if self.job.state == "running" or self._has_active_worker():
                    raise ClientError("既存の処理が完了してから境界を検出してください。")
            with self.sam_lock:
                predictor = self._sam_predictor_for(record)
                masks, scores, _logits = predictor.predict(
                    point_coords=np.asarray([point], dtype=np.float32),
                    point_labels=np.asarray([1], dtype=np.int32),
                    box=np.asarray(roi, dtype=np.float32),
                    multimask_output=True,
                )
        mask, confidence = select_best_sam_mask(masks, scores)
        clipped = clip_mask_to_roi(mask, roi)
        if polygon_mask is not None:
            clipped = np.where(polygon_mask > 0, clipped, 0).astype(np.uint8)
        if not np.any(clipped):
            raise ClientError("境界を検出できませんでした。別の位置をクリックしてください。")

        with self.lock:
            if self.images.get(image_id) is not record:
                raise ClientError("フォルダの再読み込み後に境界の検出結果を受け取ったため、破棄しました。", "catalog_changed")

        # Keep the selected SAM shape as APPLY. Hand/fluid removal is represented
        # by an independently toggleable EXCLUDE candidate just as in auto detect.
        original_mask = clipped.copy()
        with Image.open(record.path) as image:
            rgb = ImageOps.exif_transpose(image).convert("RGB")
        boundary_segment = {
            "class_name": "penis",
            "confidence": confidence,
            "mask": clipped.copy(),
            "source": "boundary",
        }
        refined_boundary = self._refine_detected_segments(
            self._ensure_models(), record, rgb, [boundary_segment]
        )[0]
        candidate_id = uuid.uuid4().hex
        candidate = Candidate(
            candidate_id=candidate_id,
            class_name="4点境界" if polygon_mask is not None else "境界",
            confidence=confidence,
            mask_path=self.cache_dir / record.image_id / f"{candidate_id}.png",
            color="#ffffff",
            source="boundary",
            origin="boundary",
        )
        with self.lock:
            if self.images.get(image_id) is not record:
                raise ClientError("フォルダを再読み込みしたため、境界の検出結果を破棄しました。")
            candidate.mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(clipped, mode="L").save(candidate.mask_path, format="PNG")
            created = [candidate]
            self.candidates.setdefault(image_id, []).append(candidate)
            for exclusion_kind, exclusion_mask in dict(refined_boundary.get("exclusions", {})).items():
                if not np.any(exclusion_mask):
                    continue
                exclusion_source = f"{exclusion_kind}_exclusion"
                exclusion_id = uuid.uuid4().hex
                exclusion = Candidate(
                    candidate_id=exclusion_id,
                    class_name=SOURCE_LABELS[exclusion_source],
                    confidence=None,
                    mask_path=self.cache_dir / record.image_id / f"{exclusion_id}.png",
                    color="#4ac3df",
                    source=exclusion_source,
                    origin="boundary",
                    role=CandidateRole.EXCLUDE,
                )
                Image.fromarray(exclusion_mask, mode="L").save(exclusion.mask_path, format="PNG")
                self.candidates[image_id].append(exclusion)
                created.append(exclusion)
            revision = self._touch_candidates(image_id)
        return {
            "candidates": [
                item.as_api_dict(SOURCE_LABELS.get(item.source, item.source), REFINEMENT_LABELS.get(item.refinement or "", ""))
                for item in created
            ],
            "candidateRevision": revision,
        }

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


STATE = StudioState()
atexit.register(STATE.shutdown)


