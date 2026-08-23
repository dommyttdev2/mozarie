from __future__ import annotations

import hashlib
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from mozarie.model_downloads import ModelDownload, ModelDownloadCancelled, ModelDownloadError, ModelDownloadManager


class _Response:
    def __init__(self, payload: bytes, url: str = "https://models.example/file", content_length: str | None = None) -> None:
        self.payload = payload
        self.offset = 0
        self.url = url
        self.headers = {} if content_length is None else {"Content-Length": content_length}

    def __enter__(self): return self
    def __exit__(self, *args): return False
    def geturl(self) -> str: return self.url
    def read(self, size: int) -> bytes:
        part = self.payload[self.offset:self.offset + size]; self.offset += len(part); return part


class _Opener:
    def __init__(self, response: _Response) -> None: self.response = response
    def open(self, request, timeout: int): return self.response


class ModelDownloadTests(unittest.TestCase):
    def entry(self, payload: bytes) -> ModelDownload:
        return ModelDownload("fixture", "target_segmentation", "https://models.example/file", "models/file.onnx", len(payload), hashlib.sha256(payload).hexdigest())

    def download(self, payload: bytes, entry: ModelDownload | None = None, **response) -> tuple[Path, ModelDownloadManager]:
        root = Path(tempfile.mkdtemp())
        manager = ModelDownloadManager(root)
        model = entry or self.entry(payload)
        fake = _Response(payload, **response)
        with patch("mozarie.model_downloads.build_opener", return_value=_Opener(fake)):
            return manager._download(model), manager

    def test_verified_download_replaces_only_after_match(self) -> None:
        destination, _manager = self.download(b"model")
        self.assertEqual(destination.read_bytes(), b"model")
        self.assertFalse(destination.with_name(".file.onnx.part").exists())

    def test_short_or_excess_downloads_leave_existing_file_untouched(self) -> None:
        for payload, expected in ((b"short", b"longer"), (b"too-long", b"tiny")):
            with self.subTest(payload=payload):
                root = Path(tempfile.mkdtemp()); manager = ModelDownloadManager(root); entry = self.entry(expected)
                destination = entry.destination(root); destination.parent.mkdir(parents=True); destination.write_bytes(b"existing")
                with patch("mozarie.model_downloads.build_opener", return_value=_Opener(_Response(payload))):
                    with self.assertRaises(ModelDownloadError): manager._download(entry)
                self.assertEqual(destination.read_bytes(), b"existing")

    def test_hash_mismatch_is_not_installed(self) -> None:
        payload = b"model"; entry = self.entry(b"other")
        root = Path(tempfile.mkdtemp()); manager = ModelDownloadManager(root)
        with patch("mozarie.model_downloads.build_opener", return_value=_Opener(_Response(payload))):
            with self.assertRaises(ModelDownloadError): manager._download(entry)
        self.assertFalse(entry.destination(root).exists())

    def test_cancelled_download_is_not_installed(self) -> None:
        payload = b"model"; entry = self.entry(payload)
        root = Path(tempfile.mkdtemp()); manager = ModelDownloadManager(root); manager._cancel.set()
        with patch("mozarie.model_downloads.build_opener", return_value=_Opener(_Response(payload))):
            with self.assertRaises(ModelDownloadCancelled): manager._download(entry)
        self.assertFalse(entry.destination(root).exists())

    def test_http_response_is_rejected(self) -> None:
        payload = b"model"; entry = self.entry(payload)
        root = Path(tempfile.mkdtemp()); manager = ModelDownloadManager(root)
        with patch("mozarie.model_downloads.build_opener", return_value=_Opener(_Response(payload, url="http://models.example/file"))):
            with self.assertRaises(ModelDownloadError): manager._download(entry)

    def test_all_download_stops_after_the_first_failure_and_keeps_prior_path(self) -> None:
        root = Path(tempfile.mkdtemp()); manager = ModelDownloadManager(root)
        calls: list[str] = []
        def download(entry: ModelDownload) -> Path:
            calls.append(entry.key)
            if len(calls) == 2: raise ModelDownloadError("fixture failure")
            path = entry.destination(root); path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(b"ok"); return path
        with patch.object(manager, "_download", side_effect=download):
            manager.start("all", "vit_b")
            while manager.snapshot()["state"] in {"running", "cancelling"}: time.sleep(0.002)
        job = manager.snapshot()
        self.assertEqual(calls, ["target", "sam_vit_b"])
        self.assertEqual(job["state"], "failed")
        self.assertIn("target_segmentation", job["paths"])


if __name__ == "__main__":
    unittest.main()
