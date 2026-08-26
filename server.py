"""Mozarie's small executable entry point."""

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

from mozarie.core import LOGGER, LOG_DATE_FORMAT, LOG_FORMAT
import mozarie.state as state_module
from mozarie.http import MosaicHandler


def _open_browser(url: str) -> None:
    try:
        if not webbrowser.open(url):
            LOGGER.warning("既定ブラウザを開けませんでした: %s", url)
    except OSError:
        LOGGER.warning("既定ブラウザを開けませんでした: %s", url)
    except Exception:
        LOGGER.exception("既定ブラウザを開けませんでした: %s", url)


def _schedule_browser_open(url: str) -> threading.Timer:
    timer = threading.Timer(0.1, _open_browser, args=(url,))
    timer.daemon = True
    timer.start()
    return timer


def main() -> None:
    logging.basicConfig(level=logging.WARNING, format=LOG_FORMAT, datefmt=LOG_DATE_FORMAT)
    LOGGER.setLevel(logging.INFO)
    parser = argparse.ArgumentParser(description="Run Mozarie locally.")
    parser.add_argument("--port", type=int, default=None, help="Override the saved local port for this start only.")
    args = parser.parse_args()
    port = args.port if args.port is not None else int(state_module.STATE.settings["general"]["port"])
    LOGGER.info("Mozarieを準備しています…")
    state_module.STATE.cache_dir.mkdir(parents=True, exist_ok=True)
    try:
        http_server = ThreadingHTTPServer(("127.0.0.1", port), MosaicHandler)
    except OSError:
        LOGGER.exception("サーバーを起動できません")
        state_module.STATE.shutdown()
        raise SystemExit(1) from None
    url = f"http://127.0.0.1:{port}"
    LOGGER.info("Mozarie を起動しました: %s", url)
    if state_module.STATE.settings["general"]["open_browser"]:
        _schedule_browser_open(url)
    try:
        http_server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        http_server.server_close()
        state_module.STATE.shutdown()
        LOGGER.info("Mozarieを終了しました")


if __name__ == "__main__":
    main()
