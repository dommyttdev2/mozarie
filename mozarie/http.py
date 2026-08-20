from .core import *
from .state import STATE
from .image_io import *


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
            elif path == "/api/update/status":
                self._json(_update_status())
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
                if "targetClasses" in payload:
                    STATE.start_detection(*detect_args, _read_target_classes(payload["targetClasses"]))
                else:
                    STATE.start_detection(*detect_args)
                self._json({"ok": True})
            elif path == "/api/candidates/batch":
                image_id = str(payload.get("imageId", ""))
                revision = STATE.batch_update_candidates(image_id, payload)
                self._json({"ok": True, "candidateRevision": revision})
            elif path == "/api/settings":
                settings = STATE.update_settings(payload)
                self._json({"settings": settings, "status": STATE.settings_status()})
            elif path == "/api/settings/reset":
                settings = STATE.reset_settings()
                self._json({"settings": settings, "status": STATE.settings_status()})
            elif path == "/api/update/start":
                self._json({"ok": True})
                threading.Thread(target=_start_update_after_response, args=(self.server,), daemon=True).start()
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
                    _read_bool(payload.get("copyToDefault", False), "既定の保存先へコピー"),
                    _read_save_suffix(payload.get("suffix", "_censored")),
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


def _read_save_suffix(value: Any) -> str:
    if not isinstance(value, str) or not value or Path(value).name != value:
        raise ClientError("ファイル名の末尾は空でない名前として指定してください。")
    return value


def _read_target_classes(value: Any) -> set[str]:
    if not isinstance(value, (list, tuple, set)):
        raise ClientError("検出対象の形式が正しくありません。")
    targets = {str(item) for item in value}
    if not targets or not targets <= TARGET_CLASSES:
        raise ClientError("検出対象は penis または pussy を選択してください。")
    return targets


def _read_bool(value: Any, field_name: str) -> bool:
    if not isinstance(value, bool):
        raise ClientError(f"{field_name}はONまたはOFFで指定してください。")
    return value


def _update_status() -> dict[str, Any]:
    from updater import display_version, fetch_latest_release, parse_version, read_local_version
    current = display_version(read_local_version())
    latest = display_version(fetch_latest_release()["tag_name"])
    return {"current": current, "latest": latest, "available": parse_version(latest) > parse_version(current)}


def _start_update_after_response(http_server: ThreadingHTTPServer) -> None:
    time.sleep(0.2)
    http_server.shutdown()
    STATE.shutdown()
    subprocess.Popen([str(APP_DIR / "update.bat")], cwd=str(APP_DIR), creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0))


