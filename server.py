"""MosaicStudio local image-review and mosaic editor.

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
import math
import mimetypes
import os
import shutil
import subprocess
import tempfile
import threading
import time
import traceback
import uuid
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
MODEL_PATH = Path(
    r"G:\AI\doujin-ai-lab\tools\ComfyUI_windows_portable\ComfyUI\models\ultralytics\segm\ntd11_anime_nsfw_segm_v5-variant1.pt"
)
SECOND_MODEL_PATH = Path(
    r"G:\AI\doujin-ai-lab\tools\ComfyUI_windows_portable\ComfyUI\models\ultralytics\sensitive_detect_v07.pt"
)
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp"}
TARGET_CLASSES = {"pussy", "penis", "anus", "testicles"}
DEFAULT_COLORS = {
    "pussy": "#ed6a5a",
    "penis": "#e6b450",
    "anus": "#a8c256",
    "testicles": "#5bb6d5",
}
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
MAX_BODY_BYTES = 80 * 1024 * 1024
FOLDER_PICKER_LOCK = threading.Lock()

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


@dataclass
class Job:
    kind: str = "idle"
    state: str = "idle"
    total: int = 0
    completed: int = 0
    current: str = ""
    error: str = ""
    started_at: float | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "state": self.state,
            "total": self.total,
            "completed": self.completed,
            "current": self.current,
            "error": self.error,
            "startedAt": self.started_at,
        }


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


def merge_segment(segments: list[dict[str, Any]], class_name: str, confidence: float, mask: np.ndarray, iou_threshold: float = 0.5) -> None:
    """Union overlapping duplicates from full-frame and tiled inference only."""
    matching = [segment for segment in segments if segment["class_name"] == class_name and mask_iou(segment["mask"], mask) >= iou_threshold]
    if not matching:
        segments.append({"class_name": class_name, "confidence": confidence, "mask": mask})
        return
    destination = matching[0]
    destination["mask"] = np.maximum(destination["mask"], mask)
    destination["confidence"] = max(destination["confidence"], confidence)
    for duplicate in matching[1:]:
        destination["mask"] = np.maximum(destination["mask"], duplicate["mask"])
        destination["confidence"] = max(destination["confidence"], duplicate["confidence"])
        segments.remove(duplicate)


class StudioState:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.root: Path | None = None
        self.images: dict[str, ImageRecord] = {}
        self.order: list[str] = []
        self.candidates: dict[str, list[Candidate]] = {}
        self.job = Job()
        self.models: list[tuple[str, YOLO]] | None = None

    def set_root(self, raw_path: str) -> list[dict[str, Any]]:
        if not raw_path or not isinstance(raw_path, str):
            raise ClientError("Windowsフォルダを入力してください。")
        root = Path(raw_path).expanduser().resolve()
        if not root.is_dir():
            raise ClientError("指定フォルダが見つかりません。")

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
            self.root = root
            self.images = {record.image_id: record for record in records}
            self.order = [record.image_id for record in records]
            self.candidates = {}
            self._clear_cache()
            self.job = Job()
        return self.list_images()

    def _clear_cache(self) -> None:
        shutil.rmtree(CACHE_DIR, ignore_errors=True)
        CACHE_DIR.mkdir(parents=True, exist_ok=True)

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
                    }
                )
            return output

    def list_candidates(self, image_id: str) -> list[dict[str, Any]]:
        self.image_for_id(image_id)
        with self.lock:
            candidates = list(self.candidates.get(image_id, []))
        return [
            {
                "id": candidate.candidate_id,
                "className": candidate.class_name,
                "confidence": candidate.confidence,
                "enabled": candidate.enabled,
                "color": candidate.color,
            }
            for candidate in candidates
        ]

    def candidate_for_id(self, image_id: str, candidate_id: str) -> Candidate:
        self.image_for_id(image_id)
        with self.lock:
            for candidate in self.candidates.get(image_id, []):
                if candidate.candidate_id == candidate_id:
                    return candidate
        raise ClientError("検出候補が見つかりません。")

    def set_candidate_state(self, image_id: str, candidate_id: str, payload: dict[str, Any]) -> None:
        candidate = self.candidate_for_id(image_id, candidate_id)
        with self.lock:
            if "enabled" in payload:
                candidate.enabled = bool(payload["enabled"])
            if "color" in payload:
                color = str(payload["color"])
                if not _valid_color(color):
                    raise ClientError("色の形式が正しくありません。")
                candidate.color = color

    def start_detection(self, image_ids: list[str]) -> None:
        records = self._records_for_ids(image_ids)
        self._start_job("detect", records, self._detect_worker)

    def start_apply(self, image_ids: list[str], block_size: int) -> None:
        records = self._records_for_ids(image_ids)
        self._start_job("apply", records, self._apply_worker, block_size)

    def _records_for_ids(self, image_ids: list[str]) -> list[ImageRecord]:
        if not isinstance(image_ids, list):
            raise ClientError("画像の選択が正しくありません。")
        source_ids = image_ids or self.order
        records = [self.image_for_id(str(image_id)) for image_id in source_ids]
        if not records:
            raise ClientError("処理する画像がありません。")
        return records

    def _start_job(self, kind: str, records: list[ImageRecord], worker: Any, *args: Any) -> None:
        with self.lock:
            if self.job.state == "running":
                raise ClientError("別の処理が進行中です。")
            self.job = Job(kind=kind, state="running", total=len(records), started_at=time.time())
        thread = threading.Thread(target=worker, args=(records, *args), daemon=True)
        thread.start()

    def _ensure_models(self) -> list[tuple[str, YOLO]]:
        with self.lock:
            if self.models is not None:
                return self.models
        if not MODEL_PATH.is_file():
            raise RuntimeError(f"検出モデルが見つかりません: {MODEL_PATH}")
        models = [(MODEL_PATH.name, YOLO(str(MODEL_PATH)))]
        if SECOND_MODEL_PATH.is_file():
            models.append((SECOND_MODEL_PATH.name, YOLO(str(SECOND_MODEL_PATH))))
        with self.lock:
            self.models = models
        return models

    def _detect_worker(self, records: list[ImageRecord]) -> None:
        try:
            models = self._ensure_models()
            for index, record in enumerate(records, start=1):
                self._set_job_current(record.relative_path, index - 1)
                candidates = self._detect_image(models, record)
                with self.lock:
                    self.candidates[record.image_id] = candidates
                self._set_job_current(record.relative_path, index)
            self._finish_job()
        except Exception as exc:  # A background job must not kill the HTTP server.
            self._fail_job(exc)

    def _detect_image(self, models: list[tuple[str, YOLO]], record: ImageRecord) -> list[Candidate]:
        with Image.open(record.path) as image:
            rgb = image.convert("RGB")
            width, height = rgb.size
        segments: list[dict[str, Any]] = []
        for _model_name, model in models:
            for x_offset, y_offset, tile_width, tile_height in detection_tiles(width, height):
                crop = rgb.crop((x_offset, y_offset, x_offset + tile_width, y_offset + tile_height))
                results = model.predict(
                    crop,
                    device=0,
                    conf=0.05,
                    imgsz=1024,
                    retina_masks=True,
                    verbose=False,
                    max_det=300,
                )
                for result in results:
                    if result.boxes is None or result.masks is None:
                        continue
                    masks = result.masks.data.cpu().numpy()
                    boxes = result.boxes.cpu()
                    names = result.names
                    for mask, box in zip(masks, boxes):
                        class_id = int(box.cls[0].item())
                        class_name = str(names[class_id])
                        if class_name not in TARGET_CLASSES:
                            continue
                        if mask.shape[:2] != (tile_height, tile_width):
                            mask = cv2.resize(mask, (tile_width, tile_height), interpolation=cv2.INTER_NEAREST)
                        local_mask = (np.asarray(mask) > 0.5).astype(np.uint8) * 255
                        if not local_mask.any():
                            continue
                        full_mask = restore_tile_mask(local_mask, width, height, x_offset, y_offset)
                        merge_segment(segments, class_name, float(box.conf[0].item()), full_mask)
        candidates: list[Candidate] = []
        destination = CACHE_DIR / record.image_id
        shutil.rmtree(destination, ignore_errors=True)
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
                )
            )
        return candidates

    def _apply_worker(self, records: list[ImageRecord], block_size: int) -> None:
        try:
            for index, record in enumerate(records, start=1):
                self._set_job_current(record.relative_path, index - 1)
                mask = self.combined_candidate_mask(record.image_id)
                if mask is not None and np.any(mask):
                    save_with_mask(record, mask, block_size)
                self._set_job_current(record.relative_path, index)
            self._finish_job()
        except Exception as exc:
            self._fail_job(exc)

    def combined_candidate_mask(self, image_id: str) -> np.ndarray | None:
        record = self.image_for_id(image_id)
        with self.lock:
            candidates = [candidate for candidate in self.candidates.get(image_id, []) if candidate.enabled]
        if not candidates:
            return None
        combined = np.zeros((record.height, record.width), dtype=np.uint8)
        for candidate in candidates:
            if not candidate.mask_path.is_file():
                continue
            with Image.open(candidate.mask_path) as mask_image:
                mask = np.asarray(mask_image.convert("L"), dtype=np.uint8)
            if mask.shape != combined.shape:
                raise RuntimeError("検出マスクのサイズが元画像と一致しません。")
            combined = np.maximum(combined, mask)
        return combined

    def _set_job_current(self, current: str, completed: int) -> None:
        with self.lock:
            self.job.current = current
            self.job.completed = completed

    def _finish_job(self) -> None:
        with self.lock:
            self.job.state = "complete"
            self.job.completed = self.job.total
            self.job.current = ""

    def _fail_job(self, exc: Exception) -> None:
        traceback.print_exc()
        with self.lock:
            self.job.state = "error"
            self.job.error = str(exc)
            self.job.current = ""


def _valid_color(value: str) -> bool:
    return len(value) == 7 and value.startswith("#") and all(char in "0123456789abcdefABCDEF" for char in value[1:])


def calculate_block_size(width: int, height: int) -> int:
    return max(4, math.ceil(max(width, height) / 100))


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


def save_with_mask(record: ImageRecord, mask: np.ndarray, block_size: int) -> None:
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
        with tempfile.NamedTemporaryFile(dir=record.path.parent, suffix=f"{record.path.suffix}.mosaicstudio.tmp", delete=False) as handle:
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
        os.replace(temporary_path, record.path)
        temporary_path = None
        os.utime(record.path, ns=(original_stat.st_atime_ns, original_stat.st_mtime_ns))
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


STATE = StudioState()


class MosaicHandler(BaseHTTPRequestHandler):
    server_version = "MosaicStudio/1.0"
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
                candidate = STATE.candidate_for_id(image_id, candidate_id)
                with Image.open(candidate.mask_path) as mask_image:
                    alpha = mask_image.convert("L")
                    rgba = Image.new("RGBA", alpha.size, (255, 255, 255, 0))
                    rgba.putalpha(alpha)
                    output = io.BytesIO()
                    rgba.save(output, format="PNG")
                self._binary(output.getvalue(), "image/png")
            else:
                self._send_static(path)
        except ClientError as exc:
            self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        except Exception as exc:  # Keep tracebacks in the terminal, not in browser.
            traceback.print_exc()
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
            elif path == "/api/detect":
                STATE.start_detection(payload.get("imageIds", []))
                self._json({"ok": True})
            elif path == "/api/apply":
                block_size = _read_block_size(payload.get("blockSize"))
                STATE.start_apply(payload.get("imageIds", []), block_size)
                self._json({"ok": True})
            elif path.endswith("/save") and path.startswith("/api/images/"):
                image_id = path.split("/")[3]
                record = STATE.image_for_id(image_id)
                mask = _decode_mask(str(payload.get("mask", "")), record.width, record.height)
                save_with_mask(record, mask, _read_block_size(payload.get("blockSize")))
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
            traceback.print_exc()
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
        print(f"[{self.log_date_time_string()}] {format % args}")


def _read_block_size(value: Any) -> int:
    try:
        block_size = int(value)
    except (TypeError, ValueError) as exc:
        raise ClientError("モザイク粗さが正しくありません。") from exc
    if not 1 <= block_size <= 2048:
        raise ClientError("モザイク粗さは1から2048の範囲で指定してください。")
    return block_size


def main() -> None:
    parser = argparse.ArgumentParser(description="Run MosaicStudio locally.")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), MosaicHandler)
    print(f"MosaicStudio: http://127.0.0.1:{args.port}")
    print("ComfyUI is not started or modified by this application.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nMosaicStudio stopped.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
