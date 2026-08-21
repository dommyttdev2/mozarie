from __future__ import annotations

import warnings

from .core import *
from .config import validate_output_directory_ready
from .image_io import *
from .runtime_types import DetectionModels
from .catalog import CatalogMixin
from .saving import SavingMixin
from .detection import DetectionMixin
from .jobs import JobsMixin


SAM_CHECKPOINT_METADATA = {
    "vit_b": {
        "tensor_count": 314,
        "shapes": {
            "image_encoder.patch_embed.proj.weight": (768, 3, 16, 16),
            "image_encoder.blocks.11.attn.qkv.weight": (2304, 768),
            "prompt_encoder.pe_layer.positional_encoding_gaussian_matrix": (2, 128),
            "mask_decoder.mask_tokens.weight": (4, 256),
        },
    },
    "vit_l": {
        "tensor_count": 482,
        "shapes": {
            "image_encoder.patch_embed.proj.weight": (1024, 3, 16, 16),
            "image_encoder.blocks.23.attn.qkv.weight": (3072, 1024),
            "prompt_encoder.pe_layer.positional_encoding_gaussian_matrix": (2, 128),
            "mask_decoder.mask_tokens.weight": (4, 256),
        },
    },
    "vit_h": {
        "tensor_count": 594,
        "shapes": {
            "image_encoder.patch_embed.proj.weight": (1280, 3, 16, 16),
            "image_encoder.blocks.31.attn.qkv.weight": (3840, 1280),
            "prompt_encoder.pe_layer.positional_encoding_gaussian_matrix": (2, 128),
            "mask_decoder.mask_tokens.weight": (4, 256),
        },
    },
}


def is_valid_sam_checkpoint_metadata(checkpoint: object, model_type: str) -> bool:
    """Recognize official flat SAM checkpoints from their loaded metadata."""
    expected = SAM_CHECKPOINT_METADATA.get(model_type)
    if not isinstance(checkpoint, dict) or expected is None or len(checkpoint) != expected["tensor_count"]:
        return False
    return all(
        key in checkpoint and tuple(checkpoint[key].shape) == shape
        for key, shape in expected["shapes"].items()
    )


def cuda_device_statuses(torch: Any) -> list[dict[str, object]]:
    """List CUDA devices that this PyTorch build can actually execute on."""
    cuda = torch.cuda
    if not cuda.is_available():
        return []
    # PyTorch emits a process-wide warning while merely enumerating an older
    # adapter. The Settings check reports that incompatibility itself.
    with warnings.catch_warnings():
        warnings.filterwarnings("ignore", category=UserWarning, module=r"torch\.cuda")
        supported_arches = set(cuda.get_arch_list())
        devices = []
        for index in range(cuda.device_count()):
            major, minor = cuda.get_device_capability(index)
            architecture = f"sm_{major}{minor}"
            devices.append({
                "id": index,
                "name": cuda.get_device_name(index),
                "architecture": architecture,
                "supported": architecture in supported_arches,
            })
    return devices


class StudioState(CatalogMixin, SavingMixin, DetectionMixin, JobsMixin):
    def __init__(self, cache_dir: Path | None = None, session_base_dir: Path | None = None) -> None:
        self.settings_store = SettingsStore(APP_DIR)
        self.settings = self.settings_store.load()
        self.lock = threading.RLock()
        self.import_lock = threading.Lock()
        self.importing_count = 0
        self.import_transfer_count = 0
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
        # These locks only serialize work for the same catalogue record.  State
        # mutation still uses ``lock``; never acquire an image lock while that
        # global lock is held.
        self._image_io_locks: dict[str, threading.RLock] = {}
        self.thumbnail_gate = threading.BoundedSemaphore(THUMBNAIL_WORKERS)
        self.import_staging_gate = threading.BoundedSemaphore(10)
        self.browser_save_tokens: dict[str, BrowserSaveToken] = {}
        self.browser_save_receipts: dict[str, BrowserSaveReceipt] = {}
        self._pending_browser_save_cleanup: list[Path] = []
        self.output_destination_lock = threading.Lock()
        # Windows native dialogs are process-modal. Keep folder and model
        # pickers mutually exclusive without blocking unrelated work.
        self.native_picker_lock = threading.Lock()
        self.reserved_output_paths: set[Path] = set()
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
        self.hand_segmentation_predictor: Any | None = None
        self.hand_segmentation_image_id: str | None = None
        self.hand_segmentation_lock = threading.RLock()
        self.inference_lock = InferenceGate()
        self._cleanup_stale_sessions()

    def update_settings(self, update: dict[str, Any]) -> dict[str, Any]:
        """Persist user-selected options and release only model objects that changed."""
        if not isinstance(update, dict):
            raise ClientError("設定の形式が正しくありません。", "invalid_settings")
        with self.inference_lock, self.lock:
            if self.importing_count or self.import_transfer_count or self.job.state in {"running", "pausing", "paused"} or self._has_active_worker():
                raise ClientError("処理中は設定を変更できません。", "job_running")
            previous_models = dict(self.settings.get("models", {}))
            previous_output_directory = self.settings["saving"]["default_output_directory"]
            try:
                settings = self.settings_store.validate_update(update)
                if settings["saving"]["default_output_directory"] != previous_output_directory:
                    validate_output_directory_ready(settings["saving"]["default_output_directory"])
                settings = self.settings_store.save(settings)
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
            if any(settings["models"].get(key) != previous_models.get(key) for key in {"hand_segmentation", "hand_segmentation_enabled", "provider", "gpu_device"}):
                self.hand_segmentation_predictor = None
                self.hand_segmentation_image_id = None
            return self.settings

    def reset_settings(self) -> dict[str, Any]:
        with self.inference_lock, self.lock:
            if self.importing_count or self.import_transfer_count or self.job.state in {"running", "pausing", "paused"} or self._has_active_worker():
                raise ClientError("処理中は設定を変更できません。", "job_running")
            try:
                settings = self.settings_store.default_settings()
                validate_output_directory_ready(settings["saving"]["default_output_directory"])
            except SettingsError as exc:
                raise ClientError("設定の内容が正しくありません。", "invalid_settings", {"detail": str(exc)}) from exc
            self.settings = self.settings_store.reset()
            self.models = None
            self.sam_predictor = None
            self.sam_image_id = None
            self.hand_segmentation_predictor = None
            self.hand_segmentation_image_id = None
            return self.settings

    def begin_import_transfer(self) -> None:
        """Block conflicting mutations from the first upload byte onward."""
        with self.lock:
            if self.job.state in {"running", "pausing", "paused"} or self._has_active_worker():
                raise ClientError("処理中は画像を追加できません。")
            self.import_transfer_count += 1

    def end_import_transfer(self) -> None:
        with self.lock:
            if self.import_transfer_count:
                self.import_transfer_count -= 1

    def settings_status(self, settings: dict[str, Any] | None = None, *, verify_sam_checkpoint: bool = False) -> dict[str, Any]:
        """Report model compatibility without constructing inference sessions."""
        models = (settings or self.settings)["models"]
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
                    "reasonCode": None,
                    "profile": None,
                }
                return
            path = Path(raw).expanduser() if raw else None
            exists = bool(path and path.is_file())
            valid = exists and (required_suffix is None or path.suffix.lower() == required_suffix)
            reason_code: str | None = None
            profile: dict[str, object] | None = None
            if not raw:
                reason_code = "not_configured"
            elif not exists:
                reason_code = "missing"
            elif not valid:
                reason_code = "invalid_format"
            if valid and key in validators:
                try:
                    profile = profile_summary(validators[key](path))
                except ModelProfileError:
                    valid = False
                    reason_code = "invalid_model"
            if valid and key == "hand_segmentation":
                try:
                    from safetensors import SafetensorError, safe_open
                except ImportError:
                    valid = False
                    reason_code = "invalid_model"
                else:
                    try:
                        with safe_open(str(path), framework="pt", device="cpu") as checkpoint:
                            valid = all(
                                key in checkpoint.keys() and tuple(checkpoint.get_slice(key).get_shape()) == shape
                                for key, shape in HAND_SEGMENTATION_VIT_B_TENSORS.items()
                            )
                        if not valid:
                            reason_code = "invalid_model"
                    except (OSError, ValueError, SafetensorError):
                        valid = False
                        reason_code = "invalid_model"
            if valid and key == "sam_checkpoint" and path.suffix.lower() not in {".pth", ".pt", ".ckpt"}:
                valid = False
                reason_code = "invalid_format"
            if valid and key == "sam_checkpoint" and verify_sam_checkpoint:
                try:
                    torch = torch_module()
                    checkpoint = torch.load(str(path), map_location="cpu", weights_only=True, mmap=True)
                    valid = is_valid_sam_checkpoint_metadata(checkpoint, models["sam_model_type"])
                    if not valid:
                        reason_code = "invalid_model"
                except (AttributeError, KeyError, OSError, RuntimeError, TypeError, ValueError):
                    valid = False
                    reason_code = "invalid_model"
            result[key] = {
                "required": required,
                "enabled": enabled,
                "configured": bool(raw),
                "exists": exists,
                "valid": valid,
                "reasonCode": reason_code,
                "profile": profile,
            }

        add_status("target_segmentation", required=True, enabled=True, required_suffix=".onnx")
        add_status("ntd11", required=False, enabled=bool(models["ntd11_enabled"]), required_suffix=".onnx")
        add_status("sensitive", required=False, enabled=bool(models["sensitive_enabled"]), required_suffix=".onnx")
        add_status("hand_detection", required=False, enabled=bool(models["hand_detection_enabled"]), required_suffix=".onnx")
        add_status(
            "hand_segmentation",
            required=False,
            enabled=bool(models.get("hand_detection_enabled")) and bool(models.get("hand_segmentation_enabled")),
            required_suffix=".safetensors",
        )
        add_status("sam_checkpoint", required=True, enabled=True)
        gpus = cuda_device_statuses(torch_module())
        selected_gpu = next((gpu for gpu in gpus if gpu["id"] == models.get("gpu_device", 0)), None)
        gpu_device_valid = models["provider"] != "gpu" or bool(selected_gpu and selected_gpu["supported"])
        return {
            "models": result,
            "provider": models["provider"],
            "samModelType": models["sam_model_type"],
            "gpus": gpus,
            "gpuDevice": models.get("gpu_device", 0),
            "gpuDeviceValid": gpu_device_valid,
            "gpuDeviceReasonCode": None if gpu_device_valid else "gpu_unsupported",
        }

    def preview_settings_status(self, update: dict[str, Any]) -> dict[str, Any]:
        try:
            settings = self.settings_store.validate_update(update)
        except SettingsError as exc:
            raise ClientError("設定の内容が正しくありません。", "invalid_settings", {"detail": str(exc)}) from exc
        return self.settings_status(settings, verify_sam_checkpoint=True)

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

    def _detach_session_unchecked(self) -> tuple[Path | None, Any | None]:
        session_dir = self.session_dir
        lock_handle = self._session_lock_handle
        self.session_dir = None
        self.session_imports_dir = None
        self._session_lock_handle = None
        return session_dir, lock_handle

    @staticmethod
    def _release_detached_session(session: tuple[Path | None, Any | None]) -> None:
        session_dir, lock_handle = session
        if lock_handle is not None:
            try:
                lock_handle.seek(0)
                msvcrt.locking(lock_handle.fileno(), msvcrt.LK_UNLCK, 1)
            except OSError:
                pass
            lock_handle.close()
        if session_dir is not None:
            shutil.rmtree(session_dir, ignore_errors=True)

STATE = StudioState()
atexit.register(STATE.shutdown)
