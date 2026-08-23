"""Pinned, on-demand downloads for the model files Mozarie can install."""

from __future__ import annotations

import hashlib
import os
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener


class ModelDownloadError(RuntimeError):
    pass


class ModelDownloadCancelled(ModelDownloadError):
    pass


class _HttpsOnlyRedirects(HTTPRedirectHandler):
    """Follow the providers' HTTPS redirects, never downgrade a download."""

    def redirect_request(self, request, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        if not newurl.lower().startswith("https://"):
            raise ModelDownloadError("モデル配布先が安全な HTTPS 接続へ移動しませんでした。")
        return super().redirect_request(request, fp, code, msg, headers, newurl)


@dataclass(frozen=True)
class ModelDownload:
    key: str
    setting_key: str
    url: str
    relative_destination: str
    size: int
    sha256: str

    def destination(self, app_dir: Path) -> Path:
        return (app_dir / self.relative_destination).resolve()


# These entries are intentionally fixed rather than resolved from a provider API.
# A download is accepted only when it matches the recorded size and SHA-256.
MODEL_DOWNLOADS: dict[str, ModelDownload] = {
    "target": ModelDownload(
        "target", "target_segmentation",
        "https://huggingface.co/01miku/anime-nsfw-segm-yolo26/resolve/1697d5d1827b6a818b350b44bf3ec27f08837a2a/nsfw-anime-xl-x1280.onnx",
        "models/nsfw-anime-xl-x1280.onnx", 126350117,
        "92046f77852b3e3d3a3ddf74575dd9d11f79f832af8d2d3e7eac186ba379194a",
    ),
    "hand_detection": ModelDownload(
        "hand_detection", "hand_detection",
        "https://huggingface.co/deepghs/anime_hand_detection/resolve/dba2c5bec15fcee9ac4909b244a84e8783cf46a2/hand_detect_v1.0_s/model.onnx",
        "models/hand_detect_v1.0_s.onnx", 44583229,
        "408750ad39645fcdc0c5e774aa45a73941b2e785fc5611fb7d3d9790a41899c0",
    ),
    "hand_segmentation": ModelDownload(
        "hand_segmentation", "hand_segmentation",
        "https://huggingface.co/Ov3rLoRd-MLEngineer/handsegnet-anime-sdxl/resolve/77ff734683306141e56aef9d491958a82508b41a/handsegnet_vit_b_best.safetensors",
        "models/handsegnet_vit_b_best.safetensors", 374979240,
        "64b35e5ee09aac8737e2554f15e73503f94ce9bf443dde4864255e14b7ca9c14",
    ),
    "sam_vit_b": ModelDownload(
        "sam_vit_b", "sam_checkpoint",
        "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth",
        "models/sam_vit_b_01ec64.pth", 375042383,
        "ec2df62732614e57411cdcf32a23ffdf28910380d03139ee0f4fcbe91eb8c912",
    ),
    "sam_vit_l": ModelDownload(
        "sam_vit_l", "sam_checkpoint",
        "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_l_0b3195.pth",
        "models/sam_vit_l_0b3195.pth", 1249524607,
        "3adcc4315b642a4d2101128f611684e8734c41232a17c648ed1693702a49a622",
    ),
    "sam_vit_h": ModelDownload(
        "sam_vit_h", "sam_checkpoint",
        "https://dl.fbaipublicfiles.com/segment_anything/sam_vit_h_4b8939.pth",
        "models/sam_vit_h_4b8939.pth", 2564550879,
        "a7bf3b02f3ebf1267aba913ff637d9a2d5c33d3173bb679e46d9f338c26f262e",
    ),
}


def _sam_key(sam_type: str) -> str:
    key = f"sam_{sam_type}"
    if key not in MODEL_DOWNLOADS:
        raise ModelDownloadError("輪郭抽出モデルの種類が正しくありません。")
    return key


class ModelDownloadManager:
    def __init__(self, app_dir: Path) -> None:
        self.app_dir = app_dir
        self._lock = threading.RLock()
        self._cancel = threading.Event()
        self._job: dict[str, Any] = {"state": "idle", "paths": {}}

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {**self._job, "paths": dict(self._job.get("paths", {}))}

    def start(self, key: str, sam_type: str) -> dict[str, Any]:
        if key == "all":
            keys = ["target", _sam_key(sam_type), "hand_detection", "hand_segmentation"]
        elif key in MODEL_DOWNLOADS:
            keys = [key]
        else:
            raise ModelDownloadError("ダウンロードするモデルの種類が正しくありません。")
        with self._lock:
            if self._job.get("state") == "running":
                return self.snapshot()
            self._cancel = threading.Event()
            self._job = {
                "state": "running", "key": key, "total": len(keys), "completed": 0,
                "current": keys[0], "received": 0, "expected": MODEL_DOWNLOADS[keys[0]].size,
                "paths": {}, "error": "",
            }
            threading.Thread(target=self._run, args=(keys,), daemon=True, name="mozarie-model-download").start()
            return self.snapshot()

    def cancel(self) -> dict[str, Any]:
        with self._lock:
            if self._job.get("state") == "running":
                self._cancel.set()
                self._job["state"] = "cancelling"
            return self.snapshot()

    def _set(self, **changes: Any) -> None:
        with self._lock:
            self._job.update(changes)

    def _run(self, keys: list[str]) -> None:
        paths: dict[str, str] = {}
        try:
            for index, key in enumerate(keys):
                if self._cancel.is_set():
                    raise ModelDownloadCancelled()
                entry = MODEL_DOWNLOADS[key]
                self._set(current=key, completed=index, received=0, expected=entry.size)
                destination = self._download(entry)
                paths[entry.setting_key] = str(destination)
                self._set(paths=dict(paths), completed=index + 1, received=entry.size)
            self._set(state="complete", current="", paths=paths)
        except ModelDownloadCancelled:
            self._set(state="cancelled", current="", paths=paths)
        except (HTTPError, URLError, OSError, ModelDownloadError) as exc:
            self._set(state="failed", current="", paths=paths, error=str(exc) or "モデルをダウンロードできませんでした。")
        except Exception:
            self._set(state="failed", current="", paths=paths, error="モデルをダウンロードできませんでした。")

    def _download(self, entry: ModelDownload) -> Path:
        destination = entry.destination(self.app_dir)
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_name(f".{destination.name}.part")
        temporary.unlink(missing_ok=True)
        digest = hashlib.sha256()
        received = 0
        try:
            opener = build_opener(_HttpsOnlyRedirects())
            request = Request(entry.url, headers={"User-Agent": "Mozarie model downloader"})
            with opener.open(request, timeout=30) as response, temporary.open("xb") as handle:
                if not response.geturl().lower().startswith("https://"):
                    raise ModelDownloadError("モデル配布先が安全な HTTPS 接続ではありません。")
                content_length = response.headers.get("Content-Length")
                if content_length and int(content_length) != entry.size:
                    raise ModelDownloadError("ダウンロードしたモデルのサイズが一致しません。")
                while chunk := response.read(1024 * 1024):
                    if self._cancel.is_set():
                        raise ModelDownloadCancelled()
                    received += len(chunk)
                    if received > entry.size:
                        raise ModelDownloadError("ダウンロードしたモデルのサイズが一致しません。")
                    digest.update(chunk)
                    handle.write(chunk)
                    self._set(received=received, expected=entry.size)
            if received != entry.size:
                raise ModelDownloadError("ダウンロードしたモデルのサイズが一致しません。")
            if digest.hexdigest() != entry.sha256:
                raise ModelDownloadError("ダウンロードしたモデルを確認できませんでした。")
            os.replace(temporary, destination)
            return destination
        except Exception:
            temporary.unlink(missing_ok=True)
            raise
