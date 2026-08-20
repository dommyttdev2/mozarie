"""Mozarie's small executable entry point and backwards-compatible API surface."""

from __future__ import annotations

import argparse
import logging
import sys
import threading
import webbrowser
from http.server import ThreadingHTTPServer
from pathlib import Path

APP_DIR = Path(__file__).resolve().parent
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from mozarie.core import *  # noqa: F403
from mozarie.image_io import *  # noqa: F403
from mozarie.image_io import _apply_mosaic_to_image, _assert_image_suffix_matches_format, _decode_mask, _default_output_destination, _verify_decodable_image
from mozarie.state import DetectionModels, STATE, StudioState
from mozarie.http import MosaicHandler, _read_candidate_revision, _read_detection_parallelism, _read_mosaic_divisor, _read_save_suffix, _read_target_classes, _start_update_after_response


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
        http_server = ThreadingHTTPServer(("127.0.0.1", port), MosaicHandler)
    except OSError:
        LOGGER.exception("サーバーを起動できません")
        STATE.shutdown()
        raise SystemExit(1) from None
    url = f"http://127.0.0.1:{port}"
    LOGGER.info("Mozarie を起動しました: %s", url)
    if STATE.settings["general"]["open_browser"]:
        _schedule_browser_open(url)
    try:
        http_server.serve_forever()
    except KeyboardInterrupt:
        LOGGER.info("Mozarie を停止します")
    finally:
        http_server.server_close()
        STATE.shutdown()
        LOGGER.info("Mozarie を停止しました")


if __name__ == "__main__":
    main()
