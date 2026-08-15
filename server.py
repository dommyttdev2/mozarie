"""Mozarie local image-review and mosaic editor.

The server never accepts a client supplied file path.  Files are first found
under a user-selected root, then addressed through opaque catalogue ids.
"""

from __future__ import annotations

import sys
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

import base64
import binascii
import argparse
import atexit
from concurrent.futures import ThreadPoolExecutor, wait
import heapq
import hashlib
import io
import json
import logging
import math
import mimetypes
import msvcrt
import os
import secrets
import shutil
import tempfile
import threading
import time
import uuid
import webbrowser
import zlib
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import unquote, urlparse

import cv2
import numpy as np
from PIL import Image, ImageOps, UnidentifiedImageError
import torch
from mozarie.domain import Candidate, CandidateRole
from mozarie.masks import compose_masks
from mozarie.boundary import polygon_roi_and_point
from mozarie.config import SettingsError, SettingsStore
from mozarie.inference.generic_yolo_segment import GenericYoloSegmenter
from mozarie.inference.profiles import (
    ModelProfileError,
    profile_summary,
    validate_generic_yolo_segment_profile,
    validate_hand_profile,
    validate_target_profile,
)
from mozarie.inference.yolo_detect import HandDetector
from mozarie.inference.yolo_segment import TargetSegmenter


STATIC_DIR = APP_DIR / "static"
CACHE_BASE_DIR = APP_DIR / ".mozarie-cache"
SESSION_BASE_DIR = Path(tempfile.gettempdir()) / "Mozarie"


IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
TARGET_CLASSES = {"pussy", "penis"}
SOURCE_PRIORITY = {"target": 3, "ntd11": 2, "sensitive": 1}
TARGET_OVERLAP_IOU = 0.20
TARGET_CONTAINMENT = 0.60
HAND_CONFIDENCE = 0.395
HAND_SAM_MIN_SCORE = 0.88
HAND_MAX_REMOVAL_RATIO = 0.70
HAND_MIN_REMAINING_RATIO = 0.15
HAND_MIN_REMAINING_PIXELS = 32
HAND_BOX_PADDING_RATIO = 0.03
HAND_BOX_PADDING_MIN = 2
HAND_BOX_PADDING_MAX = 16
FLUID_MAX_COMPONENTS = 8
FLUID_MAX_COMPONENT_RATIO = 0.15
FLUID_MAX_TOTAL_RATIO = 0.20
SOURCE_LABELS = {
    "target": "対象セグメンテーションモデル",
    "ntd11": "NTD11補助モデル",
    "sensitive": "Sensitive補助モデル",
    "boundary": "境界選択",
    "hand_exclusion": "手を除外",
    "fluid_exclusion": "白い体液を除外",
}
REFINEMENT_LABELS = {
    "hand": "手の重なりを除外",
    "fluid": "白い体液を除外",
    "hand_fluid": "手の重なりと白い体液を除外",
}
DEFAULT_COLORS = {
    "pussy": "#ed6a5a",
    "penis": "#e6b450",
    "anus": "#a8c256",
    "testicles": "#5bb6d5",
}
DEFAULT_DETECTION_CONFIDENCE = 0.50
SECONDARY_MIN_CONFIDENCE = 0.50
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
MAX_BODY_BYTES = 80 * 1024 * 1024
SAVE_TOKEN_TTL_SECONDS = 10 * 60
LOGGER = logging.getLogger(__name__)
LOG_FORMAT = "%(asctime)s | %(levelname)s | %(message)s"
LOG_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"
JOB_LABELS = {"detect": "自動検出", "apply": "ファイル保存"}

class ClientError(ValueError):
    """An invalid request that can be shown directly in the UI."""

    def __init__(self, message: str, error_code: str = "invalid_request", params: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.error_code = error_code
        self.params = params or {}


class ForbiddenClientError(ClientError):
    """A request that was not issued by this local browser session."""


class StaleMaskError(LookupError):
    """A candidate mask was removed while a browser still referenced it."""


def oriented_image_size(image: Image.Image) -> tuple[int, int]:
    width, height = image.size
    if image.getexif().get(274, 1) in {5, 6, 7, 8}:
        return height, width
    return width, height


def safe_import_relative_path(value: Any) -> Path:
    """Validate a client-provided TEMP-session relative path."""
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ClientError("画像の相対パスが不正です。")
    normalized = value.replace("\\", "/")
    if normalized.startswith("/") or (len(normalized) >= 2 and normalized[1] == ":"):
        raise ClientError("画像の相対パスが不正です。")
    parts = normalized.split("/")
    if any(not part or part in {".", ".."} or ":" in part for part in parts):
        raise ClientError("画像の相対パスが不正です。")
    return Path(*parts)


@dataclass
class ImageRecord:
    image_id: str
    path: Path
    relative_path: str
    width: int
    height: int
    mtime_ns: int
    size_bytes: int = 0
    source_kind: str = "filesystem"
    content_version: int = 0


@dataclass(frozen=True)
class BrowserSaveToken:
    image_id: str
    candidate_revision: int
    source_fingerprint: tuple[int, int, int, str]
    catalog_generation: int
    issued_at: float
    rendered_path: Path


@dataclass(frozen=True)
class BrowserSaveReceipt:
    """Completed browser save kept briefly so a lost response can be retried safely."""

    image_id: str
    candidate_revision: int
    source_action: str
    cleared: bool
    stale: bool
    deleted: bool
    completed_at: float


@dataclass
class Job:
    kind: str = "idle"
    state: str = "idle"
    total: int = 0
    completed: int = 0
    current: str = ""
    error: str = ""
    started_at: float | None = None
    outputs: list[str] = field(default_factory=list)
    image_ids: tuple[str, ...] = ()
    completed_image_ids: tuple[str, ...] = ()
    active_count: int = 0
    remove_after_save: bool = False

    def as_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "state": self.state,
            "total": self.total,
            "completed": self.completed,
            "current": self.current,
            "error": self.error,
            "startedAt": self.started_at,
            "outputs": self.outputs,
            "imageIds": list(self.image_ids),
            "completedImageIds": list(self.completed_image_ids),
            "activeCount": self.active_count,
            "removeAfterSave": self.remove_after_save,
        }


@dataclass
class JobControl:
    pause_requested: threading.Event = field(default_factory=threading.Event)
    cancel_requested: threading.Event = field(default_factory=threading.Event)


def detection_tiles(width: int, height: int) -> list[tuple[int, int, int, int]]:
    """Full image plus 65%-sized overlapping horizontal, vertical, and corner tiles."""
    tile_width = min(width, max(1, math.ceil(width * 0.65)))
    tile_height = min(height, max(1, math.ceil(height * 0.65)))
    x_offsets = (0, max(0, width - tile_width))
    y_offsets = (0, max(0, height - tile_height))
    specs = [(0, 0, width, height)]
    specs.extend((x, 0, tile_width, height) for x in x_offsets)
    specs.extend((0, y, width, tile_height) for y in y_offsets)
    specs.extend((x, y, tile_width, tile_height) for x in x_offsets for y in y_offsets)
    unique_specs: list[tuple[int, int, int, int]] = []
    for spec in specs:
        if spec not in unique_specs:
            unique_specs.append(spec)
    return unique_specs


def restore_tile_mask(mask: np.ndarray, full_width: int, full_height: int, x_offset: int, y_offset: int) -> np.ndarray:
    """Place a tile-local binary mask in its exact original-image coordinates."""
    tile_height, tile_width = mask.shape[:2]
    restored = np.zeros((full_height, full_width), dtype=np.uint8)
    restored[y_offset:y_offset + tile_height, x_offset:x_offset + tile_width] = mask
    return restored


def mask_iou(left: np.ndarray, right: np.ndarray) -> float:
    left_bool = left > 0
    right_bool = right > 0
    union = np.count_nonzero(left_bool | right_bool)
    if union == 0:
        return 0.0
    return float(np.count_nonzero(left_bool & right_bool) / union)


def mask_containment(left: np.ndarray, right: np.ndarray) -> float:
    """Return overlap relative to the smaller non-empty mask."""
    left_bool = left > 0
    right_bool = right > 0
    smallest = min(np.count_nonzero(left_bool), np.count_nonzero(right_bool))
    if smallest == 0:
        return 0.0
    return float(np.count_nonzero(left_bool & right_bool) / smallest)


def model_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def assert_onnx_cuda_available() -> None:
    """Fail early instead of allowing an ONNX model to take an accidental CPU path."""
    try:
        import onnxruntime as ort
    except ImportError as exc:
        raise ClientError("ONNX Runtimeを読み込めません。onnxruntime-gpu を確認してください。") from exc
    if "CUDAExecutionProvider" not in ort.get_available_providers():
        raise ClientError(
            "ONNX RuntimeのCUDAExecutionProviderが利用できません。"
            "GPU版ONNX RuntimeとNVIDIAドライバを確認してください。"
        )
    if not torch.cuda.is_available():
        raise ClientError("PyTorchがCUDA GPUを利用できません。NVIDIAドライバとCUDA環境を確認してください。")


def segment_overlaps(left: dict[str, Any], right: dict[str, Any], iou_threshold: float, containment_threshold: float) -> bool:
    return (
        left["class_name"] == right["class_name"]
        and (
            mask_iou(left["mask"], right["mask"]) >= iou_threshold
            or mask_containment(left["mask"], right["mask"]) >= containment_threshold
        )
    )


def _segment_rank(segment: dict[str, Any]) -> tuple[int, float]:
    return (SOURCE_PRIORITY.get(str(segment["source"]), 0), float(segment["confidence"]))


def merge_segment(
    segments: list[dict[str, Any]],
    class_name: str,
    confidence: float,
    mask: np.ndarray,
    source: str = "target",
    iou_threshold: float = 0.75,
    containment_threshold: float = 0.95,
) -> None:
    """Keep one precise representative for overlapping tile/model duplicates."""
    matching = [
        segment
        for segment in segments
        if segment["class_name"] == class_name
        and (
            mask_iou(segment["mask"], mask) >= iou_threshold
            or mask_containment(segment["mask"], mask) >= containment_threshold
        )
    ]
    if not matching:
        segments.append({"class_name": class_name, "confidence": confidence, "mask": mask, "source": source})
        return
    candidate = {"class_name": class_name, "confidence": confidence, "mask": mask, "source": source}
    winner = max([*matching, candidate], key=_segment_rank)
    for duplicate in matching:
        segments.remove(duplicate)
    segments.append(winner)


def arbitrate_segment_sources(segments: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Prefer tighter precise segments without merging distinct nearby organs."""
    ordered = sorted(
        segments,
        key=lambda segment: (-SOURCE_PRIORITY.get(str(segment["source"]), 0), -float(segment["confidence"])),
    )
    accepted: list[dict[str, Any]] = []
    for segment in ordered:
        duplicate = False
        for winner in accepted:
            if winner["source"] == segment["source"]:
                continue
            if winner["source"] == "target" or segment["source"] == "target":
                iou_threshold, containment_threshold = TARGET_OVERLAP_IOU, TARGET_CONTAINMENT
            else:
                iou_threshold, containment_threshold = 0.75, 0.95
            if segment_overlaps(winner, segment, iou_threshold, containment_threshold):
                duplicate = True
                break
        if not duplicate:
            accepted.append(segment)
    return accepted


def refine_mask_with_hand(mask: np.ndarray, hand_mask: np.ndarray) -> tuple[np.ndarray, str]:
    """Remove a SAM-confirmed hand overlap while retaining a usable genital mask."""
    genital = np.asarray(mask > 0, dtype=np.uint8)
    hand = np.asarray(hand_mask > 0, dtype=np.uint8)
    area = int(np.count_nonzero(genital))
    if area == 0 or hand.shape != genital.shape:
        return mask, "skipped"
    removed = (genital > 0) & (hand > 0)
    removal_count = int(np.count_nonzero(removed))
    if removal_count == 0:
        return mask, "unchanged"
    if removal_count / area > HAND_MAX_REMOVAL_RATIO:
        return mask, "over_cap"
    remaining = area - removal_count
    if remaining < max(math.ceil(area * HAND_MIN_REMAINING_RATIO), HAND_MIN_REMAINING_PIXELS):
        return mask, "too_small"
    refined = genital.copy()
    refined[removed] = 0
    return refined.astype(np.uint8) * 255, "refined"


def padded_hand_box(box: tuple[int, int, int, int], shape: tuple[int, int]) -> tuple[int, int, int, int] | None:
    """Expand a detected hand box slightly while keeping it inside the image."""
    left, top, right, bottom = box
    height, width = shape
    padding = max(HAND_BOX_PADDING_MIN, min(HAND_BOX_PADDING_MAX, math.ceil(max(right - left, bottom - top) * HAND_BOX_PADDING_RATIO)))
    left, top = max(0, left - padding), max(0, top - padding)
    right, bottom = min(width, right + padding), min(height, bottom + padding)
    return (left, top, right, bottom) if left < right and top < bottom else None


def accepted_hand_sam_mask(
    masks: np.ndarray, scores: np.ndarray, expected_shape: tuple[int, int], box: tuple[int, int, int, int]
) -> np.ndarray | None:
    """Return a high-confidence SAM hand mask contained by its padded detection box."""
    left, top, right, bottom = box
    if len(masks) == 0 or len(scores) == 0 or len(masks) != len(scores):
        raise ClientError("境界を検出できませんでした。別の位置をクリックしてください。")
    box_area = (right - left) * (bottom - top)
    for index in np.argsort(-np.asarray(scores), kind="stable"):
        score = float(scores[index])
        if score < HAND_SAM_MIN_SCORE:
            break
        hand_mask = np.asarray(masks[index])
        if hand_mask.shape[:2] != expected_shape:
            continue
        hand = np.asarray(hand_mask > 0, dtype=np.uint8)
        total = int(np.count_nonzero(hand))
        if total == 0:
            continue
        inside = int(np.count_nonzero(hand[top:bottom, left:right]))
        if inside / total < 0.85:
            continue
        clipped = np.zeros_like(hand, dtype=np.uint8)
        clipped[top:bottom, left:right] = hand[top:bottom, left:right]
        clipped_area = int(np.count_nonzero(clipped))
        if 0.03 <= clipped_area / box_area <= 0.95:
            return clipped * 255
    return None


def white_fluid_mask(rgb: Image.Image, penis_mask: np.ndarray) -> np.ndarray:
    """Find small, neutral-white regions contained by a penis segment."""
    penis = np.asarray(penis_mask > 0, dtype=np.uint8)
    penis_area = int(np.count_nonzero(penis))
    empty = np.zeros_like(penis, dtype=np.uint8)
    if penis_area == 0:
        return empty
    pixels = np.asarray(rgb)
    hsv = cv2.cvtColor(pixels, cv2.COLOR_RGB2HSV)
    saturation, value = hsv[:, :, 1], hsv[:, :, 2]
    channel_min = pixels.min(axis=2)
    channel_spread = pixels.max(axis=2) - channel_min
    candidate = (penis > 0) & (saturation <= 80) & (value >= 180) & (channel_spread <= 24) & (channel_min >= 215)
    seed = candidate & (saturation <= 45) & (value >= 225) & (channel_spread <= 18) & (channel_min >= 230)
    closed = cv2.morphologyEx(candidate.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((3, 3), dtype=np.uint8)) > 0
    count, labels, _stats, _centroids = cv2.connectedComponentsWithStats(closed.astype(np.uint8), connectivity=8)
    minimum = max(4, math.ceil(penis_area * 0.001))
    maximum = math.floor(penis_area * FLUID_MAX_COMPONENT_RATIO)
    total_cap = math.floor(penis_area * FLUID_MAX_TOTAL_RATIO)
    flat_labels = np.asarray(labels).ravel()
    areas = np.bincount(flat_labels[candidate.ravel()], minlength=count)
    seed_counts = np.bincount(flat_labels[seed.ravel()], minlength=count)
    eligible = [
        label
        for label in range(1, count)
        if minimum <= areas[label] <= maximum and seed_counts[label] >= 2 and seed_counts[label] / areas[label] >= 0.10
    ]
    candidates = heapq.nlargest(FLUID_MAX_COMPONENTS, eligible, key=lambda label: (areas[label], -label))
    selected_labels: list[int] = []
    selected_area = 0
    for label in candidates:
        area = int(areas[label])
        if selected_area + area > total_cap:
            continue
        selected_labels.append(label)
        selected_area += area
    selected = np.isin(labels, selected_labels) & candidate & (penis > 0)
    return np.asarray(selected, dtype=np.uint8) * 255


def read_detection_confidence(value: Any) -> float:
    try:
        confidence = float(value)
    except (TypeError, ValueError) as exc:
        raise ClientError("判定しきい値が正しくありません。") from exc
    if not 0.10 <= confidence <= 1.00:
        raise ClientError("判定しきい値は0.10から1.00の範囲で指定してください。")
    return confidence


def read_boundary_request(payload: dict[str, Any], width: int, height: int) -> tuple[tuple[int, int, int, int], tuple[float, float]]:
    """Validate a SAM point prompt and its limiting ROI in image coordinates."""
    try:
        roi_data = payload["roi"]
        point_data = payload["point"]
        left = int(round(float(roi_data["left"])))
        top = int(round(float(roi_data["top"])))
        right = int(round(float(roi_data["right"])))
        bottom = int(round(float(roi_data["bottom"])))
        point = (float(point_data["x"]), float(point_data["y"]))
    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        raise ClientError("境界の範囲またはクリック位置が正しくありません。") from exc

    if not all(math.isfinite(value) for value in (*point,)):
        raise ClientError("境界のクリック座標が正しくありません。")
    if not (0 <= left < right <= width and 0 <= top < bottom <= height):
        raise ClientError("境界の範囲は画像内にドラッグしてください。")
    inside_x = left <= point[0] < right or (right == width and point[0] == width)
    inside_y = top <= point[1] < bottom or (bottom == height and point[1] == height)
    if not (inside_x and inside_y):
        raise ClientError("クリック位置は選択範囲の内側にしてください。")
    return (left, top, right, bottom), (min(point[0], width - 1), min(point[1], height - 1))


def read_polygon_boundary_request(payload: dict[str, Any], width: int, height: int) -> tuple[tuple[int, int, int, int], tuple[float, float], np.ndarray]:
    """Validate a four-point boundary and return one SAM box/point prompt."""

    raw_points = payload.get("points")
    if not isinstance(raw_points, list):
        raise ClientError("4点境界の座標が正しくありません。")
    try:
        points = tuple((float(point["x"]), float(point["y"])) for point in raw_points)
        return polygon_roi_and_point(points, width, height)
    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        raise ClientError("4点境界は画像内の4点で指定してください。") from exc


def clip_mask_to_roi(mask: np.ndarray, roi: tuple[int, int, int, int]) -> np.ndarray:
    """Keep only the part of a SAM mask inside the user-selected ROI."""
    left, top, right, bottom = roi
    clipped = np.zeros_like(mask, dtype=np.uint8)
    clipped[top:bottom, left:right] = np.asarray(mask[top:bottom, left:right] > 0, dtype=np.uint8) * 255
    return clipped


def select_best_sam_mask(masks: np.ndarray, scores: np.ndarray) -> tuple[np.ndarray, float]:
    """Select SAM's highest-scoring proposed object mask."""
    if len(masks) == 0 or len(scores) == 0 or len(masks) != len(scores):
        raise ClientError("境界を検出できませんでした。別の位置をクリックしてください。")
    index = int(np.argmax(scores))
    return np.asarray(masks[index]), float(scores[index])


def confidence_for_source(source: str, confidence: float) -> float:
    if source == "ntd11":
        return max(0.10, confidence - 0.15)
    if source == "sensitive":
        return max(confidence, SECONDARY_MIN_CONFIDENCE)
    return confidence


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
                "hand_detection", "hand_detection_enabled", "provider",
            }
            sam_keys = {"sam_checkpoint", "sam_model_type", "provider"}
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
        return {"models": result, "provider": models["provider"], "samModelType": models["sam_model_type"]}

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
            record.path.unlink(missing_ok=True)
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
                if provider == "gpu" and not torch.cuda.is_available():
                    raise ClientError("SAMをGPUで実行できません。CPUを選ぶかCUDA環境を確認してください。", "sam_provider_unavailable")
                model = sam_model_registry[model_type](checkpoint=str(sam_path))
                model.to(device="cuda" if provider == "gpu" else "cpu")
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
    ) -> None:
        records, catalog_generation = self._records_for_ids_with_catalog(image_ids)
        self._start_job(
            "detect", records, self._detect_worker, confidence, _read_detection_parallelism(parallelism),
            expected_catalog_generation=catalog_generation,
        )

    def start_apply(
        self,
        image_ids: list[str],
        divisor: int,
        drafts: dict[str, dict[str, Any]],
        remove_after_save: bool = False,
    ) -> bool:
        records, catalog_generation = self._records_for_ids_with_catalog(image_ids)
        if any(record.source_kind != "filesystem" for record in records):
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
        self._start_job(
            "apply", records, self._apply_worker, divisor, drafts,
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
        if not isinstance(suffix, str) or not suffix or Path(suffix).name != suffix:
            raise ClientError("ファイル名の末尾は空でない名前として指定してください。")
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
        if provider == "gpu":
            assert_onnx_cuda_available()
        target = TargetSegmenter(model_path, device=provider)
        auxiliaries: list[tuple[str, GenericYoloSegmenter]] = []
        for key, label in (("ntd11", "NTD11補助モデル"), ("sensitive", "Sensitive補助モデル")):
            if not self.settings["models"][f"{key}_enabled"]:
                continue
            auxiliaries.append((key, GenericYoloSegmenter(self._configured_model_path(key, label), device=provider)))
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
        models.hand = HandDetector(model_path, device=provider)
        return models.hand

    def _detect_worker(
        self,
        records: list[ImageRecord],
        confidence: float,
        parallelism: int = 2,
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
        self, models: DetectionModels, rgb: Image.Image, confidence: float
    ) -> list[dict[str, Any]]:
        width, height = rgb.size
        segments = models.target.detect(np.asarray(rgb), confidence)
        collected = [segment for segment in segments if segment["mask"].shape == (height, width)]
        for source, model in models.auxiliaries:
            tiled_segments: list[dict[str, Any]] = []
            for x_offset, y_offset, tile_width, tile_height in detection_tiles(width, height):
                tile = np.asarray(rgb.crop((x_offset, y_offset, x_offset + tile_width, y_offset + tile_height)))
                for segment in model.detect(tile, confidence_for_source(source, confidence), source):
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
        self, models: DetectionModels, record: ImageRecord, confidence: float, mode: str | None = None
    ) -> list[Candidate]:
        self._assert_record_fresh(record)
        with Image.open(record.path) as image:
            rgb = ImageOps.exif_transpose(image).convert("RGB")
        segments = self._detect_arbitrated_segments(models, rgb, confidence)
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
        *,
        control: JobControl | None = None,
        job_generation: int | None = None,
        catalog_generation: int | None = None,
    ) -> None:
        try:
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
                save_with_mask(record, mask, calculate_block_size(record.width, record.height, divisor))
                output_stat = record.path.stat()
                record.mtime_ns = output_stat.st_mtime_ns
                record.size_bytes = output_stat.st_size
                record.content_version += 1
                with self.lock:
                    self.job.outputs.append(str(record.path))
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


def _valid_color(value: str) -> bool:
    return len(value) == 7 and value.startswith("#") and all(char in "0123456789abcdefABCDEF" for char in value[1:])


def calculate_block_size(width: int, height: int, divisor: int = 100) -> int:
    return max(4, math.ceil(max(width, height) / divisor))


def inference_device_name() -> str | None:
    if not torch.cuda.is_available():
        return None
    return torch.cuda.get_device_name(0)


def parse_png_chunks(raw: bytes) -> list[tuple[bytes, bytes]]:
    if not raw.startswith(PNG_SIGNATURE):
        raise ClientError("PNGファイルではありません。")
    chunks: list[tuple[bytes, bytes]] = []
    position = len(PNG_SIGNATURE)
    while position < len(raw):
        if position + 12 > len(raw):
            raise ClientError("PNGチャンクが壊れています。")
        length = int.from_bytes(raw[position:position + 4], "big")
        end = position + 12 + length
        if end > len(raw):
            raise ClientError("PNGチャンクが壊れています。")
        chunk_type = raw[position + 4:position + 8]
        chunks.append((chunk_type, raw[position:end]))
        position = end
    if not chunks or chunks[-1][0] != b"IEND":
        raise ClientError("PNG終端チャンクがありません。")
    return chunks


def png_ancillary_manifest(raw: bytes, *, exclude: set[bytes] | None = None) -> list[str]:
    """Hash the exact bytes of every ancillary chunk, in file order."""
    excluded = exclude or set()
    return [
        f"{chunk_type.decode('ascii', 'replace')}:{hashlib.sha256(chunk).hexdigest()}"
        for chunk_type, chunk in parse_png_chunks(raw)
        if chunk_type[0] & 0x20 and chunk_type not in excluded
    ]


def _png_chunk(chunk_type: bytes, payload: bytes) -> bytes:
    body = chunk_type + payload
    return len(payload).to_bytes(4, "big") + body + (zlib.crc32(body) & 0xFFFFFFFF).to_bytes(4, "big")


def _normalized_exif_bytes(source: bytes) -> bytes:
    with Image.open(io.BytesIO(source)) as source_image:
        exif = source_image.getexif()
    exif[274] = 1
    return exif.tobytes()


def _png_exif_payload(exif: bytes) -> bytes:
    return exif.removeprefix(b"Exif\x00\x00")


def _png_with_original_chunks(source: bytes, image: Image.Image, *, normalize_orientation: bool = False) -> bytes:
    source_chunks = parse_png_chunks(source)
    if any(chunk_type == b"acTL" for chunk_type, _chunk in source_chunks):
        raise ClientError("アニメーションPNGは保存対象外です。")
    source_ihdr = next(chunk for chunk_type, chunk in source_chunks if chunk_type == b"IHDR")

    encoded = io.BytesIO()
    image.save(encoded, format="PNG", optimize=False)
    encoded_chunks = parse_png_chunks(encoded.getvalue())
    encoded_ihdr = next(chunk for chunk_type, chunk in encoded_chunks if chunk_type == b"IHDR")
    source_ihdr_data = source_ihdr[8:-4]
    encoded_ihdr_data = encoded_ihdr[8:-4]
    if normalize_orientation:
        if source_ihdr_data[8:] != encoded_ihdr_data[8:]:
            raise ClientError("PNGの色形式またはビット深度が変化したため保存を中止しました。")
    elif source_ihdr_data != encoded_ihdr_data:
        raise ClientError("このPNGのカラーモードはメタデータを安全に保持して保存できません。")
    encoded_idat = [chunk for chunk_type, chunk in encoded_chunks if chunk_type == b"IDAT"]

    result = bytearray(PNG_SIGNATURE)
    wrote_idat = False
    normalized_exif = _png_exif_payload(_normalized_exif_bytes(source)) if normalize_orientation else None
    for chunk_type, chunk in source_chunks:
        if chunk_type == b"IHDR" and normalize_orientation:
            result.extend(encoded_ihdr)
            continue
        if chunk_type == b"eXIf" and normalized_exif is not None:
            result.extend(_png_chunk(b"eXIf", normalized_exif))
            continue
        if chunk_type == b"IDAT":
            if not wrote_idat:
                result.extend(b"".join(encoded_idat))
                wrote_idat = True
            continue
        result.extend(chunk)
    output = bytes(result)
    excluded = {b"eXIf"} if normalize_orientation else set()
    if png_ancillary_manifest(source, exclude=excluded) != png_ancillary_manifest(output, exclude=excluded):
        raise ClientError("PNGメタデータ検証に失敗したため保存を中止しました。")
    if normalize_orientation:
        with Image.open(io.BytesIO(output)) as verified:
            if verified.getexif().get(274, 1) != 1:
                raise ClientError("PNGの向き情報を正規化できませんでした。")
            verified.load()
    return output


def _parse_jpeg_header(raw: bytes) -> tuple[list[tuple[int, bytes]], bytes]:
    if not raw.startswith(b"\xff\xd8"):
        raise ClientError("JPEGファイルではありません。")
    position = 2
    segments: list[tuple[int, bytes]] = []
    while position < len(raw):
        marker_start = position
        if raw[position] != 0xFF:
            raise ClientError("JPEGヘッダ構造を安全に解析できません。")
        while position < len(raw) and raw[position] == 0xFF:
            position += 1
        if position >= len(raw):
            raise ClientError("JPEGヘッダが壊れています。")
        marker = raw[position]
        position += 1
        if marker == 0xDA:  # Start of Scan: the remaining bytes are compressed image data.
            if position + 2 > len(raw):
                raise ClientError("JPEGスキャンヘッダが壊れています。")
            length = int.from_bytes(raw[position:position + 2], "big")
            if length < 2 or position + length > len(raw):
                raise ClientError("JPEGスキャンヘッダが壊れています。")
            return segments, raw[marker_start:]
        if marker in {0xD8, 0xD9} or 0xD0 <= marker <= 0xD7 or marker == 0x01:
            raise ClientError("対応外のJPEGヘッダ構造です。")
        if position + 2 > len(raw):
            raise ClientError("JPEGヘッダが壊れています。")
        length = int.from_bytes(raw[position:position + 2], "big")
        end = position + length
        if length < 2 or end > len(raw):
            raise ClientError("JPEGヘッダが壊れています。")
        segments.append((marker, raw[marker_start:end]))
        position = end
    raise ClientError("JPEG画像データが見つかりません。")


def _is_jpeg_metadata_marker(marker: int) -> bool:
    return 0xE0 <= marker <= 0xEF or marker == 0xFE


def jpeg_metadata_manifest(raw: bytes) -> list[str]:
    segments, _scan = _parse_jpeg_header(raw)
    return [
        f"FF{marker:02X}:{hashlib.sha256(segment).hexdigest()}"
        for marker, segment in segments
        if _is_jpeg_metadata_marker(marker)
    ]


def _jpeg_metadata_manifest_from_segments(segments: list[tuple[int, bytes]]) -> list[str]:
    return [
        f"FF{marker:02X}:{hashlib.sha256(segment).hexdigest()}"
        for marker, segment in segments
        if _is_jpeg_metadata_marker(marker)
    ]


def _jpeg_exif_orientation_one_segment(source: bytes) -> bytes:
    with Image.open(io.BytesIO(source)) as source_image:
        exif = source_image.getexif()
    exif[274] = 1
    payload = exif.tobytes()
    if not payload.startswith(b"Exif\x00\x00"):
        payload = b"Exif\x00\x00" + payload
    return b"\xff\xe1" + (len(payload) + 2).to_bytes(2, "big") + payload


def _expected_image_format(suffix: str) -> str:
    expected_formats = {
        ".png": "PNG",
        ".jpg": "JPEG",
        ".jpeg": "JPEG",
        ".webp": "WEBP",
    }
    try:
        return expected_formats[suffix.lower()]
    except KeyError as exc:
        raise ClientError("Unsupported image format.") from exc


def _assert_image_suffix_matches_format(suffix: str, image_format: str | None) -> None:
    if image_format != _expected_image_format(suffix):
        raise ClientError("The image content does not match its file extension.")


def _verify_decodable_image(raw: bytes, *, expected_suffix: str | None = None) -> None:
    try:
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
            if expected_suffix is not None:
                _assert_image_suffix_matches_format(expected_suffix, image.format)
    except (OSError, UnidentifiedImageError) as exc:
        raise ClientError("保存後の画像を再読込できません。元画像は変更しません。") from exc


def _jpeg_with_original_metadata(source: bytes, image: Image.Image, *, normalize_orientation: bool = False) -> bytes:
    source_segments, _source_scan = _parse_jpeg_header(source)
    metadata_segments: list[tuple[int, bytes]] = []
    orientation_replaced = False
    for marker, segment in source_segments:
        if (
            normalize_orientation
            and not orientation_replaced
            and marker == 0xE1
            and segment[4:10] == b"Exif\x00\x00"
        ):
            metadata_segments.append((marker, _jpeg_exif_orientation_one_segment(source)))
            orientation_replaced = True
        elif _is_jpeg_metadata_marker(marker):
            metadata_segments.append((marker, segment))
    source_manifest = _jpeg_metadata_manifest_from_segments(metadata_segments)
    encoded = io.BytesIO()
    image.save(encoded, format="JPEG", quality=95)
    encoded_segments, encoded_scan = _parse_jpeg_header(encoded.getvalue())
    output = b"\xff\xd8" + b"".join(
        segment for _marker, segment in metadata_segments
    ) + b"".join(
        segment for marker, segment in encoded_segments if not _is_jpeg_metadata_marker(marker)
    ) + encoded_scan
    if source_manifest != jpeg_metadata_manifest(output):
        raise ClientError("JPEGメタデータ検証に失敗したため保存を中止しました。")
    _verify_decodable_image(output)
    return output


WEBP_METADATA_CHUNKS = {b"ICCP", b"EXIF", b"XMP "}
WEBP_SUPPORTED_CHUNKS = {b"VP8 ", b"VP8L", b"VP8X", b"ALPH", *WEBP_METADATA_CHUNKS}


def _parse_webp_chunks(raw: bytes) -> list[tuple[bytes, bytes]]:
    if len(raw) < 12 or raw[:4] != b"RIFF" or raw[8:12] != b"WEBP":
        raise ClientError("WebPファイルではありません。")
    if int.from_bytes(raw[4:8], "little") + 8 != len(raw):
        raise ClientError("WebPコンテナサイズを安全に検証できません。")
    chunks: list[tuple[bytes, bytes]] = []
    position = 12
    while position < len(raw):
        if position + 8 > len(raw):
            raise ClientError("WebPチャンクが壊れています。")
        chunk_type = raw[position:position + 4]
        size = int.from_bytes(raw[position + 4:position + 8], "little")
        end = position + 8 + size
        padded_end = end + (size % 2)
        if padded_end > len(raw):
            raise ClientError("WebPチャンクが壊れています。")
        chunks.append((chunk_type, raw[position:padded_end]))
        position = padded_end
    return chunks


def _validate_safe_webp_structure(raw: bytes) -> None:
    chunks = _parse_webp_chunks(raw)
    chunk_types = [chunk_type for chunk_type, _chunk in chunks]
    if any(chunk_type in {b"ANIM", b"ANMF"} for chunk_type in chunk_types):
        raise ClientError("アニメーションWebPは安全保証できないため保存対象外です。")
    if any(chunk_type not in WEBP_SUPPORTED_CHUNKS for chunk_type in chunk_types):
        raise ClientError("対応外のWebPチャンクがあるため保存を中止しました。")
    if sum(chunk_type in {b"VP8 ", b"VP8L"} for chunk_type in chunk_types) != 1:
        raise ClientError("WebP画像データを安全に検証できません。")


def webp_metadata_manifest(raw: bytes, *, exclude: set[bytes] | None = None) -> list[str]:
    _validate_safe_webp_structure(raw)
    excluded = exclude or set()
    return [
        f"{chunk_type.decode('ascii')}:{hashlib.sha256(chunk).hexdigest()}"
        for chunk_type, chunk in _parse_webp_chunks(raw)
        if chunk_type in WEBP_METADATA_CHUNKS and chunk_type not in excluded
    ]


def _webp_with_original_metadata(
    source: bytes, image: Image.Image, source_info: dict[str, Any], *, normalize_orientation: bool = False,
) -> bytes:
    source_manifest = webp_metadata_manifest(source, exclude={b"EXIF"} if normalize_orientation else set())
    save_args = {
        key: source_info[key]
        for key in ("icc_profile", "exif", "xmp")
        if key in source_info
    }
    if normalize_orientation:
        save_args["exif"] = _normalized_exif_bytes(source)
    encoded = io.BytesIO()
    image.save(encoded, format="WEBP", quality=95, **save_args)
    output = encoded.getvalue()
    if source_manifest != webp_metadata_manifest(output, exclude={b"EXIF"} if normalize_orientation else set()):
        raise ClientError("WebPメタデータ検証に失敗したため保存を中止しました。")
    _verify_decodable_image(output)
    if normalize_orientation:
        with Image.open(io.BytesIO(output)) as verified:
            if verified.getexif().get(274, 1) != 1:
                raise ClientError("WebPの向き情報を正規化できませんでした。")
    return output


def _apply_mosaic_to_image(image: Image.Image, mask: np.ndarray, block_size: int) -> Image.Image:
    if block_size < 1:
        raise ClientError("モザイク粗さが正しくありません。")
    original_mode = image.mode
    if original_mode not in {"RGB", "RGBA", "L"}:
        raise ClientError("この画像モードは安全保存に対応していません。")
    image_array = np.asarray(image)
    if mask.shape != image_array.shape[:2]:
        raise ClientError("マスクと画像サイズが一致しません。")
    width, height = image.size

    if original_mode == "RGBA":
        target_size = (max(1, math.ceil(width / block_size)), max(1, math.ceil(height / block_size)))
        alpha = image_array[..., 3].astype(np.float32) / 255.0
        premultiplied = image_array[..., :3].astype(np.float32) * alpha[..., None]
        small_premultiplied = cv2.resize(premultiplied, target_size, interpolation=cv2.INTER_AREA)
        small_alpha = cv2.resize(alpha, target_size, interpolation=cv2.INTER_AREA)
        pixelated_premultiplied = cv2.resize(small_premultiplied, (width, height), interpolation=cv2.INTER_NEAREST)
        pixelated_alpha = cv2.resize(small_alpha, (width, height), interpolation=cv2.INTER_NEAREST)
        pixelated_rgb = np.divide(
            pixelated_premultiplied,
            pixelated_alpha[..., None],
            out=np.zeros_like(pixelated_premultiplied),
            where=pixelated_alpha[..., None] > 0,
        )
        output = image_array.copy()
        output[..., :3] = np.where(mask[..., None] > 0, np.clip(np.rint(pixelated_rgb), 0, 255).astype(np.uint8), image_array[..., :3])
        return Image.fromarray(output, "RGBA")

    pixelated = image.resize(
        (max(1, math.ceil(width / block_size)), max(1, math.ceil(height / block_size))),
        Image.Resampling.BOX,
    ).resize((width, height), Image.Resampling.NEAREST)
    output = np.where(mask[..., None] > 0, np.asarray(pixelated), image_array) if original_mode == "RGB" else np.where(mask > 0, np.asarray(pixelated), image_array)
    return Image.fromarray(output, original_mode)


def _decode_mask(data_url: str, width: int, height: int) -> np.ndarray:
    if not isinstance(data_url, str) or not data_url.startswith("data:image/png;base64,"):
        raise ClientError("PNG形式の編集マスクが必要です。")
    try:
        raw = base64.b64decode(data_url.split(",", 1)[1], validate=True)
    except (IndexError, binascii.Error) as exc:
        raise ClientError("編集マスクを読み込めません。") from exc
    if len(raw) > MAX_BODY_BYTES:
        raise ClientError("編集マスクが大きすぎます。")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            if image.format != "PNG":
                raise ClientError("The mask must be a PNG image.")
            if image.size != (width, height):
                raise ClientError("編集マスクのサイズが元画像と一致しません。")
            if image.mode in {"RGBA", "LA"}:
                return np.asarray(image.getchannel("A"), dtype=np.uint8)
            if image.mode in {"L", "1"}:
                return np.asarray(image.convert("L"), dtype=np.uint8)
            raise ClientError("The mask must include an alpha channel or be grayscale.")
    except (OSError, UnidentifiedImageError) as exc:
        raise ClientError("編集マスクは有効なPNGではありません。") from exc


def decode_draft_masks(raw_draft: Any, width: int, height: int) -> tuple[np.ndarray | None, np.ndarray | None]:
    if raw_draft is None:
        return None, None
    if not isinstance(raw_draft, dict):
        raise ClientError("手描きマスクの形式が正しくありません。")
    add = raw_draft.get("add")
    exclusion = raw_draft.get("exclusion")
    return (
        _decode_mask(str(add), width, height) if add else None,
        _decode_mask(str(exclusion), width, height) if exclusion else None,
    )


def unique_session_import_destination(path: Path) -> Path:
    if not path.exists():
        return path
    for number in range(2, 10000):
        candidate = path.with_name(f"{path.stem}_{number}{path.suffix}")
        if not candidate.exists():
            return candidate
    raise ClientError("同名ファイルが多すぎるため保存先を決められません。")


def render_with_mask(record: ImageRecord, mask: np.ndarray, block_size: int) -> bytes:
    """Render one image without changing the source file or its catalogue state."""
    source = record.path.read_bytes()
    suffix = record.path.suffix.lower()
    with Image.open(io.BytesIO(source)) as source_image:
        source_image.load()
        normalize_orientation = source_image.getexif().get(274, 1) not in {None, 1}
        normalized = ImageOps.exif_transpose(source_image)
        modified = _apply_mosaic_to_image(normalized, mask, block_size)
        if suffix == ".png":
            return _png_with_original_chunks(source, modified, normalize_orientation=normalize_orientation)
        if suffix in {".jpg", ".jpeg"}:
            return _jpeg_with_original_metadata(source, modified, normalize_orientation=normalize_orientation)
        if suffix == ".webp":
            return _webp_with_original_metadata(source, modified, source_image.info, normalize_orientation=normalize_orientation)
    raise ClientError("この画像形式は保存に対応していません。")


def _replace_record_with_rendered_output(record: ImageRecord, rendered_path: Path) -> None:
    """Atomically replace a catalogued source with a previously verified render."""
    original_stat = record.path.stat()
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=record.path.parent, suffix=f"{record.path.suffix}.mozarie.tmp", delete=False) as handle:
            temporary_path = Path(handle.name)
            with rendered_path.open("rb") as rendered:
                shutil.copyfileobj(rendered, handle)
            handle.flush()
            os.fsync(handle.fileno())
        _verify_decodable_image(temporary_path.read_bytes())
        os.replace(temporary_path, record.path)
        temporary_path = None
        if record.source_kind == "filesystem":
            try:
                os.utime(record.path, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
            except OSError:
                LOGGER.warning("Saved image timestamp could not be restored: %s", record.path)
        stat = record.path.stat()
        record.mtime_ns = stat.st_mtime_ns
        record.size_bytes = stat.st_size
        record.content_version += 1
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def save_with_mask(record: ImageRecord, mask: np.ndarray, block_size: int) -> None:
    destination = record.path
    original_stat = record.path.stat()
    source = record.path.read_bytes()
    suffix = record.path.suffix.lower()
    with Image.open(io.BytesIO(source)) as source_image:
        source_image.load()
        normalize_orientation = source_image.getexif().get(274, 1) not in {None, 1}
        source_info = dict(source_image.info)
        source_image = ImageOps.exif_transpose(source_image)
        modified = _apply_mosaic_to_image(source_image, mask, block_size)
        if suffix == ".png":
            output = _png_with_original_chunks(source, modified, normalize_orientation=normalize_orientation)
        elif suffix in {".jpg", ".jpeg"}:
            output = _jpeg_with_original_metadata(source, modified, normalize_orientation=normalize_orientation)
        elif suffix == ".webp":
            output = _webp_with_original_metadata(source, modified, source_info, normalize_orientation=normalize_orientation)
        else:
            raise ClientError("この画像形式は安全保存に対応していません。")

    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, suffix=f"{destination.suffix}.mozarie.tmp", delete=False) as handle:
            temporary_path = Path(handle.name)
            handle.write(output)
            handle.flush()
            os.fsync(handle.fileno())
        temporary_bytes = temporary_path.read_bytes()
        if suffix == ".png" and png_ancillary_manifest(source, exclude={b"eXIf"} if normalize_orientation else set()) != png_ancillary_manifest(temporary_bytes, exclude={b"eXIf"} if normalize_orientation else set()):
            raise ClientError("PNGメタデータ検証に失敗したため置換しませんでした。")
        if suffix in {".jpg", ".jpeg"} and not normalize_orientation and jpeg_metadata_manifest(source) != jpeg_metadata_manifest(temporary_bytes):
            raise ClientError("JPEGメタデータ検証に失敗したため置換しませんでした。")
        if suffix == ".webp" and webp_metadata_manifest(source, exclude={b"EXIF"} if normalize_orientation else set()) != webp_metadata_manifest(temporary_bytes, exclude={b"EXIF"} if normalize_orientation else set()):
            raise ClientError("WebPメタデータ検証に失敗したため置換しませんでした。")
        _verify_decodable_image(temporary_bytes)
        os.replace(temporary_path, destination)
        temporary_path = None
        try:
            os.utime(destination, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
        except OSError:
            LOGGER.warning("Saved image timestamp could not be restored: %s", destination)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


STATE = StudioState()
atexit.register(STATE.shutdown)


class MosaicHandler(BaseHTTPRequestHandler):
    server_version = "Mozarie/1.0"
    protocol_version = "HTTP/1.1"

    def _reject_unread_request(self, error: ClientError) -> None:
        self.close_connection = True
        raise error

    def _require_mutation_request(self) -> None:
        host = self.headers.get("Host", "")
        expected_host = f"127.0.0.1:{self.server.server_port}"
        if host != expected_host:
            self._reject_unread_request(ForbiddenClientError("許可されていない接続先です。"))
        origin = self.headers.get("Origin", "")
        if origin != f"http://{expected_host}":
            self._reject_unread_request(ForbiddenClientError("許可されていない送信元です。"))
        fetch_site = self.headers.get("Sec-Fetch-Site", "")
        if fetch_site and fetch_site not in {"same-origin", "none"}:
            self._reject_unread_request(ForbiddenClientError("許可されていない送信元です。"))
        if self.headers.get("X-Mozarie-Token", "") != STATE.session_token:
            self._reject_unread_request(ForbiddenClientError("この画面の操作ではありません。再読み込みしてください。"))

    def _require_json_request(self) -> None:
        self._require_mutation_request()
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            self._reject_unread_request(ClientError("JSON形式のリクエストだけを受け付けます。"))

    def _require_binary_import_request(self) -> None:
        self._require_mutation_request()
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/octet-stream":
            self._reject_unread_request(ClientError("画像バイナリのリクエストだけを受け付けます。"))

    def do_GET(self) -> None:  # noqa: N802
        try:
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            if path == "/api/health":
                models = STATE.settings.get("models", {})
                configured = all(str(models.get(key, "")).strip() for key in ("target_segmentation", "sam_checkpoint"))
                configured = configured and all(
                    not bool(models.get(enabled_key)) or bool(str(models.get(path_key, "")).strip())
                    for enabled_key, path_key in (
                        ("ntd11_enabled", "ntd11"),
                        ("sensitive_enabled", "sensitive"),
                        ("hand_detection_enabled", "hand_detection"),
                    )
                )
                self._json({
                    "ok": True,
                    "modelsConfigured": configured,
                    "device": inference_device_name(),
                })
            elif path == "/api/settings":
                self._json({"settings": STATE.settings, "status": STATE.settings_status()})
            elif path == "/api/images":
                self._json({"root": str(STATE.root) if STATE.root else "", "images": STATE.list_images()})
            elif path == "/api/job":
                with STATE.lock:
                    self._json(STATE.job.as_dict())
            elif path.startswith("/api/image/"):
                self._send_image(path.removeprefix("/api/image/"), thumbnail=False)
            elif path.startswith("/api/thumbnail/"):
                self._send_image(path.removeprefix("/api/thumbnail/"), thumbnail=True)
            elif path.startswith("/api/candidates/"):
                image_id = path.removeprefix("/api/candidates/")
                self._json({"candidates": STATE.list_candidates(image_id), "candidateRevision": STATE._candidate_revision(image_id)})
            elif path.startswith("/api/mask/"):
                _, _, _, image_id, candidate_id = path.split("/", 4)
                self._binary(STATE.read_candidate_mask_png(image_id, candidate_id), "image/png")
            else:
                self._send_static(path)
        except StaleMaskError as exc:
            self._client_error(exc, HTTPStatus.NOT_FOUND, "mask_not_found")
        except ForbiddenClientError as exc:
            self._client_error(exc, HTTPStatus.FORBIDDEN)
        except ClientError as exc:
            self._client_error(exc, HTTPStatus.BAD_REQUEST)
        except Exception as exc:  # Keep tracebacks in the terminal, not in browser.
            LOGGER.exception("GET リクエストの処理に失敗: %s", self.path)
            self._client_error(exc, HTTPStatus.INTERNAL_SERVER_ERROR, "internal_error")

    def do_POST(self) -> None:  # noqa: N802
        try:
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            if path == "/api/import/file":
                self._require_binary_import_request()
                raw = self._read_binary_body()
                name = unquote(self.headers.get("X-Mozarie-Name", ""))
                relative_path = unquote(self.headers.get("X-Mozarie-Relative-Path", ""))
                client_key = unquote(self.headers.get("X-Mozarie-Client-Key", ""))
                _images, imported = STATE.import_image_bytes_for_api(
                    raw,
                    name=name,
                    relative_path=relative_path,
                    client_key=client_key,
                    include_images=False,
                )
                self._json({"imported": imported})
                return
            self._require_json_request()
            payload = self._read_json_body()
            if path == "/api/folder":
                images = STATE.set_root(str(payload.get("path", "")))
                self._json({"images": images})
            elif path == "/api/catalog/clear":
                STATE.clear_catalog()
                self._json({"images": []})
            elif path == "/api/catalog/remove":
                self._json(STATE.remove_images_from_catalog(payload.get("imageIds", [])))
            elif path == "/api/import":
                images, imported = STATE.import_images_for_api(payload.get("files", []))
                self._json({"images": images, "imported": imported})
            elif path == "/api/masks/clear":
                self._json({"cleared": STATE.clear_masks(payload.get("imageIds", []))})
            elif path == "/api/detect":
                detect_args = (
                    payload.get("imageIds", []),
                    read_detection_confidence(payload.get("confidence", STATE.settings["detection"]["threshold"])),
                    _read_detection_parallelism(payload.get("parallelism", STATE.settings["detection"]["parallelism"])),
                )
                STATE.start_detection(*detect_args)
                self._json({"ok": True})
            elif path == "/api/settings":
                settings = STATE.update_settings(payload)
                self._json({"settings": settings, "status": STATE.settings_status()})
            elif path == "/api/settings/reset":
                settings = STATE.reset_settings()
                self._json({"settings": settings, "status": STATE.settings_status()})
            elif path == "/api/boundary":
                image_id = str(payload.get("imageId", ""))
                self._json(STATE.add_boundary_candidate(image_id, payload))
            elif path == "/api/save/prepare":
                entries = STATE.prepare_browser_save(
                    payload.get("imageIds", []),
                    _read_mosaic_divisor(payload.get("divisor")),
                    str(payload.get("suffix", "_censored")),
                    _read_bool(payload.get("deleteOriginal", False), "元画像削除"),
                )
                self._json({"entries": entries})
            elif path == "/api/save/render":
                output, record, revision, save_token = STATE.render_browser_save(
                    str(payload.get("imageId", "")),
                    _read_candidate_revision(payload.get("candidateRevision")),
                    _read_mosaic_divisor(payload.get("divisor")),
                    payload.get("draft"),
                )
                self._binary(
                    output,
                    mimetypes.guess_type(record.path.name)[0] or "application/octet-stream",
                    headers={
                        "X-Mozarie-Revision": str(revision),
                        "X-Mozarie-Save-Token": save_token,
                        "X-Mozarie-Relative-Path": record.relative_path,
                        "X-Mozarie-Source-Kind": record.source_kind,
                    },
                )
            elif path == "/api/save/commit":
                self._json(STATE.commit_browser_save(
                    str(payload.get("imageId", "")),
                    _read_candidate_revision(payload.get("candidateRevision")),
                    payload.get("saveToken"),
                    payload.get("sourceAction"),
                ))
            elif path == "/api/apply":
                divisor = _read_mosaic_divisor(payload.get("divisor"))
                started = STATE.start_apply(
                    payload.get("imageIds", []), divisor, payload.get("drafts", {}),
                    _read_bool(payload.get("removeAfterSave", False), "完了後、一覧から削除"),
                )
                self._json({"ok": started, "cancelled": not started})
            elif path == "/api/job/pause":
                self._json(STATE.request_pause().as_dict())
            elif path == "/api/job/resume":
                self._json(STATE.resume_job().as_dict())
            elif path == "/api/job/cancel":
                self._json(STATE.request_cancel().as_dict())
            elif path.startswith("/api/candidate/"):
                _, _, _, image_id, candidate_id = path.split("/", 4)
                revision = STATE.set_candidate_state(image_id, candidate_id, payload)
                self._json({"ok": True, "candidateRevision": revision})
            else:
                self._client_error(ClientError("APIが見つかりません。", "api_not_found"), HTTPStatus.NOT_FOUND)
        except ForbiddenClientError as exc:
            self._client_error(exc, HTTPStatus.FORBIDDEN)
        except ClientError as exc:
            self._client_error(exc, HTTPStatus.BAD_REQUEST)
        except Exception as exc:
            LOGGER.exception("POST リクエストの処理に失敗: %s", self.path)
            self._client_error(exc, HTTPStatus.INTERNAL_SERVER_ERROR, "internal_error")

    def do_DELETE(self) -> None:  # noqa: N802
        try:
            self._require_mutation_request()
            path = unquote(urlparse(self.path).path)
            if path.startswith("/api/catalog/image/"):
                image_id = path.removeprefix("/api/catalog/image/")
                self._json({"images": STATE.remove_image_from_catalog(image_id)})
            elif path.startswith("/api/candidate/"):
                _, _, _, image_id, candidate_id = path.split("/", 4)
                deleted = STATE.delete_candidate(image_id, candidate_id)
                self._json({"deleted": deleted, "candidateRevision": STATE._candidate_revision(image_id)})
            else:
                self._client_error(ClientError("APIが見つかりません。", "api_not_found"), HTTPStatus.NOT_FOUND)
        except ForbiddenClientError as exc:
            self._client_error(exc, HTTPStatus.FORBIDDEN)
        except ClientError as exc:
            self._client_error(exc, HTTPStatus.BAD_REQUEST)
        except Exception as exc:
            LOGGER.exception("DELETE リクエストの処理に失敗: %s", self.path)
            self._client_error(exc, HTTPStatus.INTERNAL_SERVER_ERROR, "internal_error")

    def _read_json_body(self) -> dict[str, Any]:
        raw_length = self.headers.get("Content-Length")
        if raw_length is None or not raw_length.isdigit():
            raise ClientError("リクエストサイズが不正です。")
        content_length = int(raw_length)
        if content_length <= 0 or content_length > MAX_BODY_BYTES:
            raise ClientError("リクエストサイズが正しくありません。")
        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ClientError("JSONを読み込めません。") from exc
        if not isinstance(payload, dict):
            raise ClientError("JSONオブジェクトが必要です。")
        return payload

    def _read_binary_body(self) -> bytes:
        raw_length = self.headers.get("Content-Length")
        if raw_length is None or not raw_length.isdigit():
            raise ClientError("リクエストサイズが不正です。")
        content_length = int(raw_length)
        if content_length <= 0 or content_length > MAX_BODY_BYTES:
            raise ClientError("リクエストサイズが正しくありません。")
        raw = self.rfile.read(content_length)
        if len(raw) != content_length:
            raise ClientError("画像データを最後まで読み込めません。")
        return raw

    def _send_image(self, image_id: str, thumbnail: bool) -> None:
        record = STATE.image_for_id(image_id)
        if not thumbnail:
            self._binary(record.path.read_bytes(), mimetypes.guess_type(record.path.name)[0] or "application/octet-stream")
            return
        thumbnail_dir = STATE.cache_dir / "thumbnails"
        thumbnail_dir.mkdir(parents=True, exist_ok=True)
        thumbnail_path = thumbnail_dir / f"{record.image_id}-{record.mtime_ns}-{record.size_bytes}-{record.content_version}.jpg"
        for stale_thumbnail in thumbnail_dir.glob(f"{record.image_id}-*.jpg"):
            if stale_thumbnail != thumbnail_path:
                stale_thumbnail.unlink(missing_ok=True)
        if not thumbnail_path.is_file():
            with Image.open(record.path) as image:
                image = ImageOps.exif_transpose(image)
                image.thumbnail((280, 280), Image.Resampling.LANCZOS)
                output = io.BytesIO()
                image.convert("RGB").save(output, format="JPEG", quality=82)
            temporary_path: Path | None = None
            try:
                with tempfile.NamedTemporaryFile(dir=thumbnail_dir, suffix=".thumbnail.tmp", delete=False) as handle:
                    temporary_path = Path(handle.name)
                    handle.write(output.getvalue())
                    handle.flush()
                os.replace(temporary_path, thumbnail_path)
                temporary_path = None
            finally:
                if temporary_path is not None:
                    temporary_path.unlink(missing_ok=True)
        self._binary(thumbnail_path.read_bytes(), "image/jpeg")

    def _send_static(self, path: str) -> None:
        requested = "index.html" if path in {"", "/"} else path.lstrip("/")
        file_path = (STATIC_DIR / requested).resolve()
        try:
            file_path.relative_to(STATIC_DIR.resolve())
        except ValueError:
            self._json({"error": "見つかりません。"}, HTTPStatus.NOT_FOUND)
            return
        if not file_path.is_file():
            self._json({"error": "見つかりません。"}, HTTPStatus.NOT_FOUND)
            return
        data = file_path.read_bytes()
        if file_path.name == "index.html":
            data = data.replace(b"{{SESSION_TOKEN}}", STATE.session_token.encode("ascii"))
        self._binary(data, mimetypes.guess_type(file_path.name)[0] or "application/octet-stream")

    def _json(self, payload: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        self._binary(json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", status)

    def _client_error(self, error: Exception, status: HTTPStatus, default_code: str | None = None) -> None:
        code = getattr(error, "error_code", default_code or "request_failed")
        params = getattr(error, "params", {})
        self._json({"error": str(error), "error_code": code, "params": params}, status)

    def _binary(
        self,
        data: bytes,
        content_type: str,
        status: HTTPStatus = HTTPStatus.OK,
        *,
        cache_control: str = "no-store",
        headers: dict[str, str] | None = None,
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", cache_control)
        self.send_header("Content-Security-Policy", "frame-ancestors 'none'")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, value in (headers or {}).items():
            self.send_header(key, value)
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format: str, *args: Any) -> None:
        try:
            status = int(args[1])
        except (IndexError, TypeError, ValueError):
            LOGGER.warning("HTTP %s", format % args)
            return

        path = urlparse(self.path).path
        if 200 <= status < 400:
            if path.startswith("/api/") and self.command == "POST":
                LOGGER.info("API %s %s -> %d", self.command, path, status)
            return
        LOGGER.warning("HTTP %s %s -> %d", self.command, path, status)


def _read_mosaic_divisor(value: Any) -> int:
    try:
        divisor = int(value)
    except (TypeError, ValueError) as exc:
        raise ClientError("モザイク粗さが正しくありません。") from exc
    if not 1 <= divisor <= 10000:
        raise ClientError("モザイク粗さの分母は1から10000の範囲で指定してください。")
    return divisor


def _read_candidate_revision(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ClientError("候補の版番号が不正です。")
    revision = value
    if revision < 0:
        raise ClientError("候補の版番号が不正です。")
    return revision


def _read_detection_parallelism(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= 4:
        raise ClientError("並列数は1から4で指定してください。")
    return value


def _read_bool(value: Any, field_name: str) -> bool:
    if not isinstance(value, bool):
        raise ClientError(f"{field_name}はONまたはOFFで指定してください。")
    return value


def _open_browser(url: str) -> None:
    try:
        if webbrowser.open(url):
            LOGGER.info("既定ブラウザを開きました: %s", url)
        else:
            LOGGER.warning("既定ブラウザを開けませんでした: %s", url)
    except Exception:
        LOGGER.warning("既定ブラウザを開けませんでした: %s", url, exc_info=True)


def _schedule_browser_open(url: str) -> threading.Timer:
    timer = threading.Timer(0.1, _open_browser, args=(url,))
    timer.daemon = True
    timer.start()
    return timer


def main() -> None:
    logging.basicConfig(level=logging.INFO, format=LOG_FORMAT, datefmt=LOG_DATE_FORMAT)
    parser = argparse.ArgumentParser(description="Run Mozarie locally.")
    parser.add_argument("--port", type=int, default=None, help="Override the saved local port for this start only.")
    args = parser.parse_args()
    port = args.port if args.port is not None else int(STATE.settings["general"]["port"])
    STATE.cache_dir.mkdir(parents=True, exist_ok=True)
    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), MosaicHandler)
    except OSError:
        LOGGER.exception("サーバーを起動できません")
        STATE.shutdown()
        raise SystemExit(1) from None
    url = f"http://127.0.0.1:{port}"
    LOGGER.info("Mozarie を起動しました: %s", url)
    if STATE.settings["general"]["open_browser"]:
        _schedule_browser_open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        LOGGER.info("Mozarie を停止します")
    finally:
        server.server_close()
        STATE.shutdown()
        LOGGER.info("Mozarie を停止しました")


if __name__ == "__main__":
    main()
