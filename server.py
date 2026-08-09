"""Lets Censoring local image-review and mosaic editor.

The server never accepts a client supplied file path.  Files are first found
under a user-selected root, then addressed through opaque catalogue ids.
"""

from __future__ import annotations

import base64
import binascii
import argparse
import hashlib
import io
import json
import logging
import math
import mimetypes
import os
import shutil
import subprocess
import tempfile
import threading
import time
import uuid
import webbrowser
from dataclasses import dataclass, field
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlparse

import cv2
import numpy as np
from PIL import Image, UnidentifiedImageError
import torch
from ultralytics import YOLO


APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
CACHE_DIR = APP_DIR / ".mosaicstudio-cache"


@dataclass(frozen=True)
class LocalModelManifest:
    """Pinned local model metadata. Files remain local and are never downloaded by the app."""

    name: str
    path: Path
    size: int
    sha256: str
    revision: str
    license: str
    url: str


PRECISE_MODEL = LocalModelManifest(
    name="精密性器セグメンテーション",
    path=APP_DIR / "models" / "ultralytics" / "nsfw-anime-xl-x1280.onnx",
    size=126_350_117,
    sha256="92046f77852b3e3d3a3ddf74575dd9d11f79f832af8d2d3e7eac186ba379194a",
    revision="1697d5d1827b6a818b350b44bf3ec27f08837a2a",
    license="MIT",
    url="https://huggingface.co/01miku/anime-nsfw-segm-yolo26/resolve/1697d5d1827b6a818b350b44bf3ec27f08837a2a/nsfw-anime-xl-x1280.onnx",
)
HAND_MODEL = LocalModelManifest(
    name="アニメ手検出",
    path=APP_DIR / "models" / "ultralytics" / "anime-hand-v1.0-s.onnx",
    size=44_583_229,
    sha256="408750ad39645fcdc0c5e774aa45a73941b2e785fc5611fb7d3d9790a41899c0",
    revision="0c4ab4d",
    license="OpenRAIL",
    url="https://huggingface.co/deepghs/anime_hand_detection/resolve/0c4ab4d/hand_detect_v1.0_s/model.onnx",
)
MODEL_PATH = Path(
    r"G:\AI\doujin-ai-lab\tools\ComfyUI_windows_portable\ComfyUI\models\ultralytics\segm\ntd11_anime_nsfw_segm_v5-variant1.pt"
)
SECOND_MODEL_PATH = Path(
    r"G:\AI\doujin-ai-lab\tools\ComfyUI_windows_portable\ComfyUI\models\ultralytics\sensitive_detect_v07.pt"
)
SAM_MODEL_PATH = APP_DIR / "models" / "sam_vit_b_01ec64.pth"
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
TARGET_CLASSES = {"pussy", "penis"}
SOURCE_PRIORITY = {"precise": 3, "primary": 2, "secondary": 1}
PRECISE_OVERLAP_IOU = 0.20
PRECISE_CONTAINMENT = 0.60
HAND_CONFIDENCE = 0.395
HAND_MAX_REMOVAL_RATIO = 0.20
SOURCE_LABELS = {
    "precise": "精密性器モデル",
    "primary": "補助検出モデル",
    "secondary": "補助検出モデル2",
    "boundary": "境界選択",
}
REFINEMENT_LABELS = {"hand": "手の重なりを除外"}
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
FOLDER_PICKER_LOCK = threading.Lock()
LOGGER = logging.getLogger(__name__)
LOG_FORMAT = "%(asctime)s | %(levelname)s | %(message)s"
LOG_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"
JOB_LABELS = {"detect": "自動検出", "apply": "ファイル保存"}

FOLDER_PICKER_SCRIPT = r"""
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$source = @'
using System;
using System.Runtime.InteropServices;

namespace MosaicStudio {
    [Flags]
    internal enum FOS : uint {
        FOS_PICKFOLDERS = 0x00000020,
        FOS_FORCEFILESYSTEM = 0x00000040,
        FOS_PATHMUSTEXIST = 0x00000800,
    }

    internal enum SigDn : uint {
        FileSystemPath = 0x80058000,
    }

    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItem {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem parent);
        void GetDisplayName(SigDn sigdnName, out IntPtr name);
        void GetAttributes(uint mask, out uint attributes);
        void Compare(IShellItem other, uint hint, out int order);
    }

    [ComImport, Guid("B63EA76D-1F85-456F-A19C-48159EFA858B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItemArray { }

    // This is deliberately flat: COM interface inheritance must retain the
    // complete native IFileOpenDialog vtable order in its managed definition.
    [ComImport, Guid("D57C7288-D4AD-4768-BE02-9D969532D960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IFileOpenDialog {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint count, IntPtr filters);
        void SetFileTypeIndex(uint index);
        void GetFileTypeIndex(out uint index);
        void Advise(IntPtr events, out uint cookie);
        void Unadvise(uint cookie);
        void SetOptions(FOS options);
        void GetOptions(out FOS options);
        void SetDefaultFolder(IShellItem folder);
        void SetFolder(IShellItem folder);
        void GetFolder(out IShellItem folder);
        void GetCurrentSelection(out IShellItem item);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string text);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
        void GetResult(out IShellItem item);
        void AddPlace(IShellItem item, int alignment);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string extension);
        void Close(int result);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr filter);
        void GetResults(out IShellItemArray results);
        void GetSelectedItems(out IShellItemArray items);
    }

    [ComImport, Guid("DC1C5A9C-E88A-4DDE-A5A1-60F82A20AEF7")]
    internal class FileOpenDialogClass { }

    internal static class Native {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
        internal static extern void SHCreateItemFromParsingName(
            string path, IntPtr bindContext, ref Guid riid, out IShellItem shellItem);

        [DllImport("user32.dll")]
        internal static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        internal static extern bool SetForegroundWindow(IntPtr window);
    }

    public static class FolderPicker {
        private const int ErrorCancelled = unchecked((int)0x800704C7);
        private static readonly Guid ShellItemIid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");

        public static string Pick(string initialPath) {
            IFileOpenDialog dialog = null;
            IShellItem defaultFolder = null;
            IShellItem result = null;
            try {
                dialog = (IFileOpenDialog)new FileOpenDialogClass();
                FOS options;
                dialog.GetOptions(out options);
                dialog.SetOptions(options | FOS.FOS_PICKFOLDERS | FOS.FOS_FORCEFILESYSTEM | FOS.FOS_PATHMUSTEXIST);
                dialog.SetTitle("画像フォルダを選択してください");
                dialog.SetOkButtonLabel("選択");

                if (!String.IsNullOrWhiteSpace(initialPath)) {
                    Guid shellItemIid = ShellItemIid;
                    Native.SHCreateItemFromParsingName(initialPath, IntPtr.Zero, ref shellItemIid, out defaultFolder);
                    dialog.SetDefaultFolder(defaultFolder);
                }

                IntPtr owner = Native.GetForegroundWindow();
                if (owner != IntPtr.Zero) Native.SetForegroundWindow(owner);
                int showResult = dialog.Show(owner);
                if (showResult == ErrorCancelled) return null;
                if (showResult < 0) Marshal.ThrowExceptionForHR(showResult);

                dialog.GetResult(out result);
                IntPtr pathPointer = IntPtr.Zero;
                try {
                    result.GetDisplayName(SigDn.FileSystemPath, out pathPointer);
                    string path = Marshal.PtrToStringUni(pathPointer);
                    if (String.IsNullOrWhiteSpace(path)) throw new COMException("Folder path was not returned.");
                    return path;
                }
                finally {
                    if (pathPointer != IntPtr.Zero) Marshal.FreeCoTaskMem(pathPointer);
                }
            }
            finally {
                if (result != null) Marshal.FinalReleaseComObject(result);
                if (defaultFolder != null) Marshal.FinalReleaseComObject(defaultFolder);
                if (dialog != null) Marshal.FinalReleaseComObject(dialog);
            }
        }
    }
}
'@

Add-Type -TypeDefinition $source -Language CSharp
$initialPath = [Environment]::GetEnvironmentVariable('MOSAIC_STUDIO_INITIAL_FOLDER', 'Process')
$selectedPath = [MosaicStudio.FolderPicker]::Pick($initialPath)
if ($null -ne $selectedPath) {
    [Console]::Out.Write($selectedPath)
}
"""


class ClientError(ValueError):
    """An invalid request that can be shown directly in the UI."""


class StaleMaskError(LookupError):
    """A candidate mask was removed while a browser still referenced it."""


@dataclass
class ImageRecord:
    image_id: str
    path: Path
    relative_path: str
    width: int
    height: int
    mtime_ns: int


@dataclass
class Candidate:
    candidate_id: str
    class_name: str
    confidence: float
    mask_path: Path
    enabled: bool = True
    color: str = "#5bb6d5"
    source: str = "auto"
    refinement: str | None = None


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


def normalize_precise_class(class_name: str) -> str | None:
    """Map the precise model's labels onto Lets Censoring's stable class names."""
    normalized = class_name.strip().lower()
    if normalized == "vagina":
        return "pussy"
    if normalized == "penis":
        return "penis"
    return None


def model_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_model_manifest(manifest: LocalModelManifest) -> None:
    """Reject missing or changed model files before Ultralytics attempts to load them."""
    if not manifest.path.is_file():
        raise ClientError(f"{manifest.name}モデルが見つかりません: {manifest.path}")
    actual_size = manifest.path.stat().st_size
    if actual_size != manifest.size:
        raise ClientError(
            f"{manifest.name}モデルのサイズが一致しません。再ダウンロードしてください。"
        )
    if model_sha256(manifest.path).lower() != manifest.sha256.lower():
        raise ClientError(
            f"{manifest.name}モデルのSHA-256が一致しません。再ダウンロードしてください。"
        )


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


def assert_onnx_cuda_active(model: YOLO, manifest: LocalModelManifest) -> None:
    """Confirm Ultralytics did not silently select the CPU execution provider."""
    backend = getattr(getattr(model, "predictor", None), "model", None)
    session = getattr(getattr(backend, "backend", backend), "session", None)
    providers = list(session.get_providers()) if session is not None else []
    if not providers or providers[0] != "CUDAExecutionProvider":
        detail = ", ".join(providers) if providers else "取得できません"
        raise ClientError(
            f"{manifest.name}モデルがCUDAで実行されていません（現在: {detail}）。"
            "ONNX RuntimeのCUDA設定を確認してください。"
        )


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
    source: str = "primary",
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
            if winner["source"] == "precise" or segment["source"] == "precise":
                iou_threshold, containment_threshold = PRECISE_OVERLAP_IOU, PRECISE_CONTAINMENT
            else:
                iou_threshold, containment_threshold = 0.75, 0.95
            if segment_overlaps(winner, segment, iou_threshold, containment_threshold):
                duplicate = True
                break
        if not duplicate:
            accepted.append(segment)
    return accepted


def refine_mask_with_hand(mask: np.ndarray, hand_mask: np.ndarray) -> tuple[np.ndarray, str]:
    """Conservatively remove a SAM-confirmed hand fringe from a fallback genital mask."""
    genital = np.asarray(mask > 0, dtype=np.uint8)
    hand = np.asarray(hand_mask > 0, dtype=np.uint8)
    area = int(np.count_nonzero(genital))
    if area == 0 or hand.shape != genital.shape:
        return mask, "skipped"
    distance = cv2.distanceTransform(genital, cv2.DIST_L2, 3)
    core_radius = max(1.0, min(float(distance.max()), math.sqrt(area) * 0.12))
    core = distance >= core_radius
    removed = (genital > 0) & (hand > 0) & ~core
    removal_count = int(np.count_nonzero(removed))
    if removal_count == 0:
        return mask, "unchanged"
    if removal_count / area > HAND_MAX_REMOVAL_RATIO:
        return mask, "over_cap"
    refined = genital.copy()
    refined[removed] = 0
    return refined.astype(np.uint8) * 255, "refined"


def accepted_hand_sam_mask(masks: np.ndarray, scores: np.ndarray, expected_shape: tuple[int, int]) -> np.ndarray | None:
    """Return SAM's best full-image hand mask without using a bounding box as a mask."""
    hand_mask, _score = select_best_sam_mask(masks, scores)
    if hand_mask.shape[:2] != expected_shape:
        return None
    hand = np.asarray(hand_mask > 0, dtype=np.uint8) * 255
    return hand if np.any(hand) else None


def read_detection_confidence(value: Any) -> float:
    try:
        confidence = float(value)
    except (TypeError, ValueError) as exc:
        raise ClientError("判定しきい値が正しくありません。") from exc
    if not 0.10 <= confidence <= 0.90:
        raise ClientError("判定しきい値は0.10から0.90の範囲で指定してください。")
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
    if not (left <= point[0] < right and top <= point[1] < bottom):
        raise ClientError("クリック位置は選択範囲の内側にしてください。")
    return (left, top, right, bottom), point


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
    return max(0.10, confidence - 0.15) if source == "primary" else max(confidence, SECONDARY_MIN_CONFIDENCE)


def precise_confidence(confidence: float) -> float:
    return max(0.05, confidence - 0.30)


def confidence_for_class(source: str, class_name: str, confidence: float) -> float:
    return confidence if source == "primary" else max(confidence, SECONDARY_MIN_CONFIDENCE)


@dataclass
class DetectionModels:
    precise: YOLO
    primary: YOLO | None = None
    secondary: YOLO | None = None
    hand: YOLO | None = None
    precise_provider_checked: bool = False
    hand_provider_checked: bool = False


class StudioState:
    def __init__(self, cache_dir: Path | None = None) -> None:
        self.lock = threading.RLock()
        self.import_lock = threading.Lock()
        self.cache_dir = Path(cache_dir) if cache_dir is not None else CACHE_DIR
        self.root: Path | None = None
        self.images: dict[str, ImageRecord] = {}
        self.order: list[str] = []
        self.candidates: dict[str, list[Candidate]] = {}
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

    def _has_active_worker(self) -> bool:
        return self.worker_thread is not None and self.worker_thread.is_alive()

    def _assert_catalog_mutable(self) -> None:
        if self.job.state in {"running", "paused"} or self._has_active_worker():
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
                    width, height = image.size
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
                )
            )

        records.sort(key=lambda record: record.relative_path.lower())
        with self.lock:
            self._assert_catalog_mutable()
            self.root = root
            self.images = {record.image_id: record for record in records}
            self.order = [record.image_id for record in records]
            self.candidates = {}
            self._clear_cache()
            self._invalidate_sam_cache()
            self.job = Job()
            self.catalog_generation += 1
        return self.list_images()

    def clear_catalog(self) -> None:
        with self.import_lock:
            with self.lock:
                self._assert_catalog_mutable()
                self.images = {}
                self.order = []
                self.candidates = {}
                self._clear_cache()
                self._invalidate_sam_cache()
                self.catalog_generation += 1

    def clear_masks(self, image_ids: list[str]) -> int:
        records = self._records_for_ids(image_ids)
        with self.lock:
            if self.job.state in {"running", "paused"} or self._has_active_worker():
                raise ClientError("処理中はモザイク候補をクリアできません。")
            self._clear_masks_unchecked(records)
        return len(records)

    def _clear_masks_unchecked(self, records: list[ImageRecord]) -> None:
        for record in records:
            for candidate in self.candidates.pop(record.image_id, []):
                candidate.mask_path.unlink(missing_ok=True)
            shutil.rmtree(self.cache_dir / record.image_id, ignore_errors=True)

    def import_images(self, files: list[dict[str, Any]]) -> list[dict[str, Any]]:
        if not isinstance(files, list) or not files:
            raise ClientError("追加する画像がありません。")
        with self.import_lock:
            with self.lock:
                root = self.root
                catalog_generation = self.catalog_generation
                if self.job.state in {"running", "paused"} or self._has_active_worker():
                    raise ClientError("処理中は画像を追加できません。")
            if root is None:
                raise ClientError("画像を追加する前に画像フォルダを読み込んでください。")

            destination_dir = root / ".mosaicstudio_imports"
            destination_dir.mkdir(parents=True, exist_ok=True)
            pending: list[tuple[Path, str, int, int]] = []
            try:
                for file_data in files:
                    if not isinstance(file_data, dict):
                        raise ClientError("画像データの形式が正しくありません。")
                    name = Path(str(file_data.get("name", ""))).name
                    if not name or Path(name).suffix.lower() not in IMAGE_SUFFIXES:
                        continue
                    try:
                        raw = base64.b64decode(str(file_data.get("data", "")), validate=True)
                    except (binascii.Error, ValueError) as exc:
                        raise ClientError("追加画像を読み込めません。") from exc
                    if not raw:
                        continue
                    _verify_decodable_image(raw)
                    with Image.open(io.BytesIO(raw)) as image:
                        width, height = image.size
                    temporary = destination_dir / f".mosaicstudio-import-{uuid.uuid4().hex}.tmp"
                    pending.append((temporary, name, width, height))
                    temporary.write_bytes(raw)

                with self.lock:
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
                        for temporary, name, width, height in pending:
                            destination = unique_destination(destination_dir / name)
                            os.replace(temporary, destination)
                            final_paths.append(destination)
                            stat = destination.stat()
                            added.append(
                                ImageRecord(
                                    uuid.uuid4().hex,
                                    destination,
                                    destination.relative_to(root).as_posix(),
                                    width,
                                    height,
                                    stat.st_mtime_ns,
                                )
                            )
                    except Exception:
                        for destination in final_paths:
                            destination.unlink(missing_ok=True)
                        raise
                    for record in added:
                        self.images[record.image_id] = record
                        self.order.append(record.image_id)
                    self.order.sort(key=lambda image_id: self.images[image_id].relative_path.lower())
                    return self.list_images()
            finally:
                for temporary, _name, _width, _height in pending:
                    temporary.unlink(missing_ok=True)

    def _clear_cache(self) -> None:
        shutil.rmtree(self.cache_dir, ignore_errors=True)
        self.cache_dir.mkdir(parents=True, exist_ok=True)

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
                if not SAM_MODEL_PATH.is_file():
                    raise ClientError(
                        f"SAMモデルが見つかりません: {SAM_MODEL_PATH}。"
                        "READMEの案内に従って配置してください。"
                    )
                try:
                    from segment_anything import SamPredictor, sam_model_registry
                except ImportError as exc:
                    raise ClientError("SAMのPythonパッケージを読み込めません。") from exc
                model = sam_model_registry["vit_b"](checkpoint=str(SAM_MODEL_PATH))
                model.to(device="cuda" if torch.cuda.is_available() else "cpu")
                self.sam_predictor = SamPredictor(model)

            if self.sam_image_id != record.image_id:
                with Image.open(record.path) as image:
                    self.sam_predictor.set_image(np.asarray(image.convert("RGB")))
                self.sam_image_id = record.image_id
            return self.sam_predictor

    def image_for_id(self, image_id: str) -> ImageRecord:
        with self.lock:
            record = self.images.get(image_id)
            root = self.root
        if record is None or root is None:
            raise ClientError("画像が見つかりません。フォルダを再読込してください。")
        try:
            record.path.resolve().relative_to(root)
        except ValueError as exc:
            raise ClientError("許可されていない画像パスです。") from exc
        if not record.path.is_file():
            raise ClientError("画像ファイルが見つかりません。")
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
                        "width": record.width,
                        "height": record.height,
                        "candidateCount": len(self.candidates.get(image_id, [])),
                        "enabledCandidateCount": sum(candidate.enabled for candidate in self.candidates.get(image_id, [])),
                    }
                )
            return output

    def list_candidates(self, image_id: str) -> list[dict[str, Any]]:
        self.image_for_id(image_id)
        with self.lock:
            candidates = [candidate for candidate in self.candidates.get(image_id, []) if candidate.mask_path.is_file()]
            self.candidates[image_id] = candidates
        return [
            {
                "id": candidate.candidate_id,
                "className": candidate.class_name,
                "confidence": candidate.confidence,
                "enabled": candidate.enabled,
                "color": candidate.color,
                "source": candidate.source,
                "sourceLabel": SOURCE_LABELS.get(candidate.source, candidate.source),
                "refinement": candidate.refinement,
                "refinementLabel": REFINEMENT_LABELS.get(candidate.refinement or "", ""),
            }
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
                raise StaleMaskError("検出候補は既に更新されています。") from exc

    def set_candidate_state(self, image_id: str, candidate_id: str, payload: dict[str, Any]) -> None:
        self.image_for_id(image_id)
        with self.lock:
            candidate = next(
                (candidate for candidate in self.candidates.get(image_id, []) if candidate.candidate_id == candidate_id),
                None,
            )
            if candidate is None:
                raise ClientError("検出候補が見つかりません。")
            if "enabled" in payload:
                candidate.enabled = bool(payload["enabled"])
            if "color" in payload:
                color = str(payload["color"])
                if not _valid_color(color):
                    raise ClientError("色の形式が正しくありません。")
                candidate.color = color

    def start_detection(self, image_ids: list[str], confidence: float = DEFAULT_DETECTION_CONFIDENCE) -> None:
        records, catalog_generation = self._records_for_ids_with_catalog(image_ids)
        self._start_job("detect", records, self._detect_worker, confidence, expected_catalog_generation=catalog_generation)

    def start_apply(
        self,
        image_ids: list[str],
        divisor: int,
        mode: str,
        suffix: str,
        delete_original: bool,
        drafts: dict[str, dict[str, Any]],
    ) -> None:
        records, catalog_generation = self._records_for_ids_with_catalog(image_ids)
        if mode not in {"copy", "overwrite"}:
            raise ClientError("保存方法が正しくありません。")
        if mode == "copy" and (not isinstance(suffix, str) or not suffix or Path(suffix).name != suffix):
            raise ClientError("ファイル名の末尾が正しくありません。")
        if not isinstance(drafts, dict):
            raise ClientError("手描きマスクの形式が正しくありません。")
        decoded_drafts = {
            record.image_id: decode_draft_masks(drafts.get(record.image_id), record.width, record.height)
            for record in records
        }
        prepared_masks = {
            record.image_id: self.combined_candidate_mask(record.image_id, decoded_drafts[record.image_id])
            for record in records
        }
        records = [record for record in records if prepared_masks[record.image_id] is not None and np.any(prepared_masks[record.image_id])]
        if not records:
            raise ClientError("保存するモザイク範囲がありません。")
        self._start_job(
            "apply", records, self._apply_worker, divisor, mode, suffix if mode == "copy" else "",
            bool(delete_original and mode == "copy"), prepared_masks, expected_catalog_generation=catalog_generation,
        )

    def request_pause(self) -> Job:
        with self.lock:
            if self.job.kind != "apply" or self.job.state != "running":
                raise ClientError("一時停止できるモザイク適用はありません。")
            assert self.job_control is not None
            self.job_control.pause_requested.set()
            return self.job

    def resume_apply(self) -> Job:
        with self.lock:
            if self.job.kind != "apply" or self.job.state != "paused":
                raise ClientError("再開できるモザイク適用はありません。")
            assert self.job_control is not None
            self.job_control.pause_requested.clear()
            self.job.state = "running"
            return self.job

    def request_cancel(self) -> Job:
        with self.lock:
            if self.job.kind != "apply" or self.job.state not in {"running", "paused"}:
                raise ClientError("キャンセルできるモザイク適用はありません。")
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
        records = [self.image_for_id(str(image_id)) for image_id in source_ids]
        if not records:
            raise ClientError("処理する画像がありません。")
        return records

    def _records_for_ids_with_catalog(self, image_ids: list[str]) -> tuple[list[ImageRecord], int]:
        if not isinstance(image_ids, list):
            raise ClientError("画像の選択が正しくありません。")
        with self.lock:
            source_ids = image_ids or list(self.order)
            records = [self.images.get(str(image_id)) for image_id in source_ids]
            root = self.root
            catalog_generation = self.catalog_generation
        if root is None or not records or any(record is None for record in records):
            raise ClientError("処理する画像がありません。")
        verified_records = [record for record in records if record is not None]
        for record in verified_records:
            try:
                record.path.resolve().relative_to(root)
            except ValueError as exc:
                raise ClientError("許可されていない画像パスです。") from exc
            if not record.path.is_file():
                raise ClientError("画像ファイルが見つかりません。")
        return verified_records, catalog_generation

    def _start_job(
        self,
        kind: str,
        records: list[ImageRecord],
        worker: Any,
        *args: Any,
        expected_catalog_generation: int | None = None,
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
    ) -> None:
        with self.lock:
            if self.job.state in {"running", "paused"} or self._has_active_worker():
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

    def _ensure_models(self) -> DetectionModels:
        with self.lock:
            if self.models is not None:
                return self.models
        validate_model_manifest(PRECISE_MODEL)
        assert_onnx_cuda_available()
        models = DetectionModels(
            precise=YOLO(str(PRECISE_MODEL.path), task="segment"),
        )
        if MODEL_PATH.is_file():
            models.primary = YOLO(str(MODEL_PATH))
        if SECOND_MODEL_PATH.is_file():
            models.secondary = YOLO(str(SECOND_MODEL_PATH))
        with self.lock:
            self.models = models
        return models

    def _ensure_hand_model(self, models: DetectionModels) -> YOLO:
        if models.hand is not None:
            return models.hand
        validate_model_manifest(HAND_MODEL)
        assert_onnx_cuda_available()
        models.hand = YOLO(str(HAND_MODEL.path), task="detect")
        return models.hand

    def _detect_worker(
        self,
        records: list[ImageRecord],
        confidence: float,
        *,
        control: JobControl | None = None,
        job_generation: int | None = None,
        catalog_generation: int | None = None,
    ) -> None:
        try:
            models = self._ensure_models()
            for index, record in enumerate(records, start=1):
                if not self._job_is_current(job_generation, catalog_generation):
                    return
                self._set_job_current(record.relative_path, index - 1, job_generation, catalog_generation)
                with self.inference_lock:
                    candidates = self._detect_image(models, record, confidence)
                with self.lock:
                    if not self._job_is_current(job_generation, catalog_generation):
                        self._discard_candidates(candidates)
                        return
                    boundary_candidates = [
                        candidate for candidate in self.candidates.get(record.image_id, [])
                        if candidate.source == "boundary"
                    ]
                    for candidate in self.candidates.get(record.image_id, []):
                        if candidate.source != "boundary":
                            candidate.mask_path.unlink(missing_ok=True)
                    self.candidates[record.image_id] = [*boundary_candidates, *candidates]
                self._set_job_current(record.relative_path, index, job_generation, catalog_generation)
            self._finish_job(job_generation, catalog_generation)
        except Exception as exc:  # A background job must not kill the HTTP server.
            self._fail_job(exc, job_generation, catalog_generation)

    def _discard_candidates(self, candidates: list[Candidate]) -> None:
        for candidate in candidates:
            candidate.mask_path.unlink(missing_ok=True)

    def _segments_from_results(
        self,
        results: Any,
        *,
        source: str,
        width: int,
        height: int,
        x_offset: int = 0,
        y_offset: int = 0,
        full_width: int | None = None,
        full_height: int | None = None,
        precise_only: bool = False,
        confidence: float,
    ) -> list[dict[str, Any]]:
        segments: list[dict[str, Any]] = []
        for result in results:
            if result.boxes is None or result.masks is None:
                continue
            masks = result.masks.data.cpu().numpy()
            boxes = result.boxes.cpu()
            names = result.names
            for mask, box in zip(masks, boxes):
                raw_class = str(names[int(box.cls[0].item())])
                class_name = normalize_precise_class(raw_class) if precise_only else raw_class
                if class_name is None or class_name not in TARGET_CLASSES:
                    continue
                score = float(box.conf[0].item())
                if not precise_only and score < confidence_for_class(source, class_name, confidence):
                    continue
                if mask.shape[:2] != (height, width):
                    mask = cv2.resize(mask, (width, height), interpolation=cv2.INTER_NEAREST)
                local_mask = (np.asarray(mask) > 0.5).astype(np.uint8) * 255
                if not local_mask.any():
                    continue
                full_mask = restore_tile_mask(
                    local_mask,
                    full_width if full_width is not None else width,
                    full_height if full_height is not None else height,
                    x_offset,
                    y_offset,
                )
                merge_segment(segments, class_name, score, full_mask, source)
        return segments

    def _detect_precise_segments(
        self, models: DetectionModels, rgb: Image.Image, confidence: float
    ) -> list[dict[str, Any]]:
        width, height = rgb.size
        results = models.precise.predict(
            rgb,
            device=0,
            conf=precise_confidence(confidence),
            imgsz=1280,
            retina_masks=True,
            verbose=False,
            max_det=300,
            iou=0.85,
        )
        if not models.precise_provider_checked:
            assert_onnx_cuda_active(models.precise, PRECISE_MODEL)
            models.precise_provider_checked = True
        return self._segments_from_results(
            results,
            source="precise",
            width=width,
            height=height,
            precise_only=True,
            confidence=confidence,
        )

    def _detect_legacy_segments(
        self, models: DetectionModels, rgb: Image.Image, confidence: float
    ) -> list[dict[str, Any]]:
        width, height = rgb.size
        segments: list[dict[str, Any]] = []
        legacy_models: list[tuple[str, YOLO]] = []
        if models.primary is not None:
            legacy_models.append(("primary", models.primary))
        if models.secondary is not None:
            legacy_models.append(("secondary", models.secondary))
        for source, model in legacy_models:
            for x_offset, y_offset, tile_width, tile_height in detection_tiles(width, height):
                crop = rgb.crop((x_offset, y_offset, x_offset + tile_width, y_offset + tile_height))
                results = model.predict(
                    crop,
                    device=0,
                    conf=confidence_for_source(source, confidence),
                    imgsz=1024,
                    retina_masks=True,
                    verbose=False,
                    max_det=300,
                    iou=0.85,
                )
                for segment in self._segments_from_results(
                    results,
                    source=source,
                    width=tile_width,
                    height=tile_height,
                    x_offset=x_offset,
                    y_offset=y_offset,
                    full_width=width,
                    full_height=height,
                    confidence=confidence,
                ):
                    merge_segment(
                        segments,
                        segment["class_name"],
                        segment["confidence"],
                        segment["mask"],
                        segment["source"],
                    )
        return segments

    def _hand_boxes(self, models: DetectionModels, rgb: Image.Image) -> list[tuple[int, int, int, int]]:
        hand_model = self._ensure_hand_model(models)
        results = hand_model.predict(rgb, device=0, conf=HAND_CONFIDENCE, imgsz=640, verbose=False, max_det=100, iou=0.70)
        if not models.hand_provider_checked:
            assert_onnx_cuda_active(hand_model, HAND_MODEL)
            models.hand_provider_checked = True
        boxes: list[tuple[int, int, int, int]] = []
        for result in results:
            if result.boxes is None:
                continue
            for box in result.boxes.cpu():
                left, top, right, bottom = (int(round(value)) for value in box.xyxy[0].tolist())
                if right > left and bottom > top:
                    boxes.append((left, top, right, bottom))
        return boxes

    @staticmethod
    def _box_intersects_mask(box: tuple[int, int, int, int], mask: np.ndarray) -> bool:
        left, top, right, bottom = box
        height, width = mask.shape[:2]
        left, right = max(0, left), min(width, right)
        top, bottom = max(0, top), min(height, bottom)
        return left < right and top < bottom and bool(np.any(mask[top:bottom, left:right] > 0))

    def _refine_fallback_segments(
        self, models: DetectionModels, record: ImageRecord, rgb: Image.Image, segments: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        fallback = [segment for segment in segments if segment["source"] in {"primary", "secondary"}]
        if not fallback:
            return segments
        hand_boxes = self._hand_boxes(models, rgb)
        if not hand_boxes:
            return segments
        predictor = self._sam_predictor_for(record)
        for segment in fallback:
            combined_hand_mask = np.zeros_like(segment["mask"], dtype=np.uint8)
            for box in hand_boxes:
                if not self._box_intersects_mask(box, segment["mask"]):
                    continue
                masks, scores, _ = predictor.predict(
                    point_coords=None,
                    point_labels=None,
                    box=np.asarray(box, dtype=np.float32),
                    multimask_output=True,
                )
                hand_mask = accepted_hand_sam_mask(masks, scores, segment["mask"].shape[:2])
                if hand_mask is not None:
                    combined_hand_mask = np.maximum(combined_hand_mask, hand_mask)
            refined, decision = refine_mask_with_hand(segment["mask"], combined_hand_mask)
            if decision == "refined":
                segment["mask"] = refined
                segment["refinement"] = "hand"
        return segments

    def _detect_image(self, models: DetectionModels, record: ImageRecord, confidence: float) -> list[Candidate]:
        with Image.open(record.path) as image:
            rgb = image.convert("RGB")
        segments = arbitrate_segment_sources([
            *self._detect_precise_segments(models, rgb, confidence),
            *self._detect_legacy_segments(models, rgb, confidence),
        ])
        segments = self._refine_fallback_segments(models, record, rgb, segments)
        candidates: list[Candidate] = []
        destination = self.cache_dir / record.image_id
        destination.mkdir(parents=True, exist_ok=True)
        for segment in segments:
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
        return candidates

    def add_boundary_candidate(self, image_id: str, payload: dict[str, Any]) -> dict[str, Any]:
        record = self.image_for_id(image_id)
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
        if not np.any(clipped):
            raise ClientError("境界を検出できませんでした。別の位置をクリックしてください。")

        candidate_id = uuid.uuid4().hex
        candidate = Candidate(
            candidate_id=candidate_id,
            class_name="境界",
            confidence=confidence,
            mask_path=self.cache_dir / record.image_id / f"{candidate_id}.png",
            color="#ffffff",
            source="boundary",
        )
        with self.lock:
            if self.images.get(image_id) is not record:
                raise ClientError("フォルダを再読み込みしたため、境界の検出結果を破棄しました。")
            candidate.mask_path.parent.mkdir(parents=True, exist_ok=True)
            Image.fromarray(clipped, mode="L").save(candidate.mask_path, format="PNG")
            self.candidates.setdefault(image_id, []).append(candidate)
        return {
            "id": candidate.candidate_id,
            "className": candidate.class_name,
            "confidence": candidate.confidence,
            "enabled": candidate.enabled,
            "color": candidate.color,
            "source": candidate.source,
            "sourceLabel": SOURCE_LABELS.get(candidate.source, candidate.source),
            "refinement": candidate.refinement,
            "refinementLabel": REFINEMENT_LABELS.get(candidate.refinement or "", ""),
        }

    def _apply_worker(
        self,
        records: list[ImageRecord],
        divisor: int,
        mode: str,
        suffix: str,
        delete_original: bool,
        prepared_masks: dict[str, np.ndarray | None],
        *,
        control: JobControl | None = None,
        job_generation: int | None = None,
        catalog_generation: int | None = None,
    ) -> None:
        try:
            for index, record in enumerate(records, start=1):
                if not self._job_is_current(job_generation, catalog_generation):
                    return
                if control is not None and control.cancel_requested.is_set():
                    self._cancel_job(job_generation, catalog_generation)
                    return
                self._wait_while_paused(control, job_generation, catalog_generation)
                if control is not None and control.cancel_requested.is_set():
                    self._cancel_job(job_generation, catalog_generation)
                    return
                self._set_job_current(record.relative_path, index - 1, job_generation, catalog_generation)
                mask = prepared_masks.get(record.image_id)
                if mask is None or not np.any(mask):
                    raise ClientError("検出候補のマスクが見つかりません。自動検出をやり直してください。")
                output = record.path if mode == "overwrite" else unique_destination(
                    record.path.with_name(f"{record.path.stem}{suffix}{record.path.suffix}")
                )
                save_with_mask(record, mask, calculate_block_size(record.width, record.height, divisor), output)
                if mode == "copy" and delete_original:
                    record.path.unlink()
                    record.path = output
                    record.relative_path = output.relative_to(self.root).as_posix() if self.root else output.name
                    record.mtime_ns = output.stat().st_mtime_ns
                elif mode == "copy":
                    copied_stat = output.stat()
                    copied = ImageRecord(
                        uuid.uuid4().hex, output,
                        output.relative_to(self.root).as_posix() if self.root else output.name,
                        record.width, record.height, copied_stat.st_mtime_ns,
                    )
                    with self.lock:
                        self.images[copied.image_id] = copied
                        self.order.append(copied.image_id)
                        self.order.sort(key=lambda image_id: self.images[image_id].relative_path.lower())
                with self.lock:
                    self.job.outputs.append(str(output))
                self.invalidate_sam_image(record.image_id)
                with self.lock:
                    self._clear_masks_unchecked([record])
                self._mark_image_completed(record.image_id, job_generation, catalog_generation)
                self._set_job_current(record.relative_path, index, job_generation, catalog_generation)
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

    def combined_candidate_mask(
        self,
        image_id: str,
        draft: tuple[np.ndarray | None, np.ndarray | None] | None = None,
    ) -> np.ndarray | None:
        record = self.image_for_id(image_id)
        add_mask, exclusion_mask = draft or (None, None)
        with self.lock:
            candidates = [candidate for candidate in self.candidates.get(image_id, []) if candidate.enabled]
            if not candidates and add_mask is None:
                return None
            combined = np.zeros((record.height, record.width), dtype=np.uint8)
            for candidate in candidates:
                try:
                    with Image.open(candidate.mask_path) as mask_image:
                        mask = np.asarray(mask_image.convert("L"), dtype=np.uint8)
                except FileNotFoundError as exc:
                    raise ClientError("検出候補のマスクが見つかりません。自動検出をやり直してください。") from exc
                if mask.shape != combined.shape:
                    raise RuntimeError("検出マスクのサイズが元画像と一致しません。")
                combined = np.maximum(combined, mask)
        if add_mask is not None:
            combined = np.maximum(combined, add_mask)
        if exclusion_mask is not None:
            combined[exclusion_mask > 0] = 0
        return combined

    def _set_job_current(self, current: str, completed: int, job_generation: int | None = None, catalog_generation: int | None = None) -> None:
        with self.lock:
            if self._job_is_current(job_generation, catalog_generation):
                self.job.current = current
                self.job.completed = completed

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
        LOGGER.exception("バックグラウンド処理に失敗: %s", JOB_LABELS.get(kind, kind))


def _valid_color(value: str) -> bool:
    return len(value) == 7 and value.startswith("#") and all(char in "0123456789abcdefABCDEF" for char in value[1:])


def calculate_block_size(width: int, height: int, divisor: int = 100) -> int:
    return max(4, math.ceil(max(width, height) / divisor))


def inference_device_name() -> str | None:
    if not torch.cuda.is_available():
        return None
    return torch.cuda.get_device_name(0)


def pick_windows_folder(initial_path: str) -> dict[str, Any]:
    if not FOLDER_PICKER_LOCK.acquire(blocking=False):
        raise ClientError("フォルダ参照ダイアログは既に開いています。")
    try:
        initial = ""
        if initial_path:
            candidate = Path(initial_path).expanduser()
            if candidate.is_dir():
                initial = str(candidate.resolve())
        environment = os.environ.copy()
        environment["MOSAIC_STUDIO_INITIAL_FOLDER"] = initial
        try:
            completed = subprocess.run(
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-STA",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    FOLDER_PICKER_SCRIPT,
                ],
                capture_output=True,
                check=False,
                env=environment,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except OSError as exc:
            raise ClientError("Windowsフォルダ参照ダイアログを開けませんでした。") from exc
        if completed.returncode != 0:
            raise ClientError("Windowsフォルダ参照ダイアログを開けませんでした。")
        try:
            selected_text = completed.stdout.decode("utf-8-sig").strip("\r\n")
        except UnicodeDecodeError as exc:
            raise ClientError("フォルダ参照結果をUTF-8で読み取れませんでした。") from exc
        if not selected_text:
            return {"cancelled": True}
        selected = Path(selected_text).resolve()
        if not selected.is_dir():
            raise ClientError("選択されたフォルダが見つかりません。")
        return {"cancelled": False, "path": str(selected)}
    finally:
        FOLDER_PICKER_LOCK.release()


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


def png_ancillary_manifest(raw: bytes) -> list[str]:
    """Hash the exact bytes of every ancillary chunk, in file order."""
    return [
        f"{chunk_type.decode('ascii', 'replace')}:{hashlib.sha256(chunk).hexdigest()}"
        for chunk_type, chunk in parse_png_chunks(raw)
        if chunk_type[0] & 0x20
    ]


def _png_with_original_chunks(source: bytes, image: Image.Image) -> bytes:
    source_chunks = parse_png_chunks(source)
    if any(chunk_type == b"acTL" for chunk_type, _chunk in source_chunks):
        raise ClientError("アニメーションPNGは保存対象外です。")
    source_ihdr = next(chunk for chunk_type, chunk in source_chunks if chunk_type == b"IHDR")

    encoded = io.BytesIO()
    image.save(encoded, format="PNG", optimize=False)
    encoded_chunks = parse_png_chunks(encoded.getvalue())
    encoded_ihdr = next(chunk for chunk_type, chunk in encoded_chunks if chunk_type == b"IHDR")
    if source_ihdr[8:-4] != encoded_ihdr[8:-4]:
        raise ClientError("このPNGのカラーモードはメタデータを安全に保持して保存できません。")
    encoded_idat = [chunk for chunk_type, chunk in encoded_chunks if chunk_type == b"IDAT"]

    result = bytearray(PNG_SIGNATURE)
    wrote_idat = False
    for chunk_type, chunk in source_chunks:
        if chunk_type == b"IDAT":
            if not wrote_idat:
                result.extend(b"".join(encoded_idat))
                wrote_idat = True
            continue
        result.extend(chunk)
    output = bytes(result)
    if png_ancillary_manifest(source) != png_ancillary_manifest(output):
        raise ClientError("PNGメタデータ検証に失敗したため保存を中止しました。")
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


def _verify_decodable_image(raw: bytes) -> None:
    try:
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
    except UnidentifiedImageError as exc:
        raise ClientError("保存後の画像を再読込できません。元画像は変更しません。") from exc


def _jpeg_with_original_metadata(source: bytes, image: Image.Image) -> bytes:
    source_segments, _source_scan = _parse_jpeg_header(source)
    source_manifest = jpeg_metadata_manifest(source)
    encoded = io.BytesIO()
    image.save(encoded, format="JPEG", quality=95)
    encoded_segments, encoded_scan = _parse_jpeg_header(encoded.getvalue())
    output = b"\xff\xd8" + b"".join(
        segment for marker, segment in source_segments if _is_jpeg_metadata_marker(marker)
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


def webp_metadata_manifest(raw: bytes) -> list[str]:
    _validate_safe_webp_structure(raw)
    return [
        f"{chunk_type.decode('ascii')}:{hashlib.sha256(chunk).hexdigest()}"
        for chunk_type, chunk in _parse_webp_chunks(raw)
        if chunk_type in WEBP_METADATA_CHUNKS
    ]


def _webp_with_original_metadata(source: bytes, image: Image.Image, source_info: dict[str, Any]) -> bytes:
    source_manifest = webp_metadata_manifest(source)
    save_args = {
        key: source_info[key]
        for key in ("icc_profile", "exif", "xmp")
        if key in source_info
    }
    encoded = io.BytesIO()
    image.save(encoded, format="WEBP", quality=95, **save_args)
    output = encoded.getvalue()
    if source_manifest != webp_metadata_manifest(output):
        raise ClientError("WebPメタデータ検証に失敗したため保存を中止しました。")
    _verify_decodable_image(output)
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
        rgb = image.convert("RGB")
        pixelated = rgb.resize(
            (max(1, math.ceil(width / block_size)), max(1, math.ceil(height / block_size))),
            Image.Resampling.BOX,
        ).resize((width, height), Image.Resampling.NEAREST)
        output = image_array.copy()
        output[..., :3] = np.where(mask[..., None] > 0, np.asarray(pixelated), image_array[..., :3])
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
            if image.size != (width, height):
                raise ClientError("編集マスクのサイズが元画像と一致しません。")
            return np.asarray(image.convert("L"), dtype=np.uint8)
    except UnidentifiedImageError as exc:
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


def unique_destination(path: Path) -> Path:
    if not path.exists():
        return path
    for number in range(2, 10000):
        candidate = path.with_name(f"{path.stem}_{number}{path.suffix}")
        if not candidate.exists():
            return candidate
    raise ClientError("同名ファイルが多すぎるため保存先を決められません。")


def save_with_mask(record: ImageRecord, mask: np.ndarray, block_size: int, destination: Path | None = None) -> None:
    destination = destination or record.path
    original_stat = record.path.stat()
    source = record.path.read_bytes()
    suffix = record.path.suffix.lower()
    with Image.open(io.BytesIO(source)) as source_image:
        source_image.load()
        modified = _apply_mosaic_to_image(source_image, mask, block_size)
        if suffix == ".png":
            output = _png_with_original_chunks(source, modified)
        elif suffix in {".jpg", ".jpeg"}:
            output = _jpeg_with_original_metadata(source, modified)
        elif suffix == ".webp":
            output = _webp_with_original_metadata(source, modified, source_image.info)
        else:
            raise ClientError("この画像形式は安全保存に対応していません。")

    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, suffix=f"{destination.suffix}.mosaicstudio.tmp", delete=False) as handle:
            temporary_path = Path(handle.name)
            handle.write(output)
            handle.flush()
            os.fsync(handle.fileno())
        temporary_bytes = temporary_path.read_bytes()
        if suffix == ".png" and png_ancillary_manifest(source) != png_ancillary_manifest(temporary_bytes):
            raise ClientError("PNGメタデータ検証に失敗したため置換しませんでした。")
        if suffix in {".jpg", ".jpeg"} and jpeg_metadata_manifest(source) != jpeg_metadata_manifest(temporary_bytes):
            raise ClientError("JPEGメタデータ検証に失敗したため置換しませんでした。")
        if suffix == ".webp" and webp_metadata_manifest(source) != webp_metadata_manifest(temporary_bytes):
            raise ClientError("WebPメタデータ検証に失敗したため置換しませんでした。")
        _verify_decodable_image(temporary_bytes)
        os.replace(temporary_path, destination)
        temporary_path = None
        os.utime(destination, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


STATE = StudioState(CACHE_DIR)


class MosaicHandler(BaseHTTPRequestHandler):
    server_version = "LetsCensoring/1.0"
    protocol_version = "HTTP/1.1"

    def do_GET(self) -> None:  # noqa: N802
        try:
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            if path == "/api/health":
                self._json({"ok": True, "modelExists": MODEL_PATH.is_file(), "device": inference_device_name()})
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
                self._json({"candidates": STATE.list_candidates(path.removeprefix("/api/candidates/"))})
            elif path.startswith("/api/mask/"):
                _, _, _, image_id, candidate_id = path.split("/", 4)
                self._binary(STATE.read_candidate_mask_png(image_id, candidate_id), "image/png")
            else:
                self._send_static(path)
        except StaleMaskError as exc:
            self._json({"error": str(exc)}, HTTPStatus.NOT_FOUND)
        except ClientError as exc:
            self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception as exc:  # Keep tracebacks in the terminal, not in browser.
            LOGGER.exception("GET リクエストの処理に失敗: %s", self.path)
            self._json({"error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def do_POST(self) -> None:  # noqa: N802
        try:
            parsed = urlparse(self.path)
            path = unquote(parsed.path)
            payload = self._read_json_body()
            if path == "/api/pick-folder":
                self._json(pick_windows_folder(str(payload.get("path", ""))))
            elif path == "/api/folder":
                images = STATE.set_root(str(payload.get("path", "")))
                self._json({"images": images})
            elif path == "/api/catalog/clear":
                STATE.clear_catalog()
                self._json({"images": []})
            elif path == "/api/import":
                self._json({"images": STATE.import_images(payload.get("files", []))})
            elif path == "/api/masks/clear":
                self._json({"cleared": STATE.clear_masks(payload.get("imageIds", []))})
            elif path == "/api/detect":
                STATE.start_detection(
                    payload.get("imageIds", []),
                    read_detection_confidence(payload.get("confidence", DEFAULT_DETECTION_CONFIDENCE)),
                )
                self._json({"ok": True})
            elif path == "/api/boundary":
                image_id = str(payload.get("imageId", ""))
                self._json({"candidate": STATE.add_boundary_candidate(image_id, payload)})
            elif path == "/api/apply":
                divisor = _read_mosaic_divisor(payload.get("divisor"))
                STATE.start_apply(
                    payload.get("imageIds", []), divisor,
                    str(payload.get("mode", "copy")), str(payload.get("suffix", "_censored")),
                    bool(payload.get("deleteOriginal", False)), payload.get("drafts", {}),
                )
                self._json({"ok": True})
            elif path == "/api/job/pause":
                self._json(STATE.request_pause().as_dict())
            elif path == "/api/job/resume":
                self._json(STATE.resume_apply().as_dict())
            elif path == "/api/job/cancel":
                self._json(STATE.request_cancel().as_dict())
            elif path.endswith("/save") and path.startswith("/api/images/"):
                image_id = path.split("/")[3]
                record = STATE.image_for_id(image_id)
                mask = _decode_mask(str(payload.get("mask", "")), record.width, record.height)
                save_with_mask(record, mask, calculate_block_size(record.width, record.height, _read_mosaic_divisor(payload.get("divisor"))))
                STATE.invalidate_sam_image(image_id)
                self._json({"ok": True})
            elif path.startswith("/api/candidate/"):
                _, _, _, image_id, candidate_id = path.split("/", 4)
                STATE.set_candidate_state(image_id, candidate_id, payload)
                self._json({"ok": True})
            else:
                self._json({"error": "APIが見つかりません。"}, HTTPStatus.NOT_FOUND)
        except ClientError as exc:
            self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception as exc:
            LOGGER.exception("POST リクエストの処理に失敗: %s", self.path)
            self._json({"error": str(exc)}, HTTPStatus.INTERNAL_SERVER_ERROR)

    def _read_json_body(self) -> dict[str, Any]:
        content_length = int(self.headers.get("Content-Length", "0"))
        if content_length <= 0 or content_length > MAX_BODY_BYTES:
            raise ClientError("リクエストサイズが正しくありません。")
        try:
            payload = json.loads(self.rfile.read(content_length).decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ClientError("JSONを読み込めません。") from exc
        if not isinstance(payload, dict):
            raise ClientError("JSONオブジェクトが必要です。")
        return payload

    def _send_image(self, image_id: str, thumbnail: bool) -> None:
        record = STATE.image_for_id(image_id)
        if not thumbnail:
            self._binary(record.path.read_bytes(), mimetypes.guess_type(record.path.name)[0] or "application/octet-stream")
            return
        with Image.open(record.path) as image:
            image.thumbnail((280, 280), Image.Resampling.LANCZOS)
            output = io.BytesIO()
            image.convert("RGB").save(output, format="JPEG", quality=82)
        self._binary(output.getvalue(), "image/jpeg")

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
        self._binary(file_path.read_bytes(), mimetypes.guess_type(file_path.name)[0] or "application/octet-stream")

    def _json(self, payload: Any, status: HTTPStatus = HTTPStatus.OK) -> None:
        self._binary(json.dumps(payload, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8", status)

    def _binary(self, data: bytes, content_type: str, status: HTTPStatus = HTTPStatus.OK) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
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
    parser = argparse.ArgumentParser(description="Run Lets Censoring locally.")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    STATE.cache_dir.mkdir(parents=True, exist_ok=True)
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), MosaicHandler)
    except OSError:
        LOGGER.exception("サーバーを起動できません")
        raise SystemExit(1) from None
    url = f"http://127.0.0.1:{args.port}"
    LOGGER.info("Lets Censoring を起動しました: %s", url)
    _schedule_browser_open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        LOGGER.info("Lets Censoring を停止します")
    finally:
        server.server_close()
        LOGGER.info("Lets Censoring を停止しました")


if __name__ == "__main__":
    main()
