"""Mozarie's small executable entry point."""

from __future__ import annotations

import argparse
import logging
import sys
import threading
import types
import webbrowser
from http.server import ThreadingHTTPServer
from pathlib import Path

logging.basicConfig(
    level=logging.WARNING,
    format="%(asctime)s | %(levelname)s | %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

APP_DIR = Path(__file__).resolve().parent
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from mozarie.core import LOGGER, LOG_DATE_FORMAT, LOG_FORMAT
from updater import MaintenanceLock, UpdateError


def _handle_server_error(server: ThreadingHTTPServer, request, client_address) -> None:  # type: ignore[no-untyped-def]
    """Avoid a terminal traceback when a browser closes a normal request."""
    exception = sys.exc_info()[1]
    if isinstance(exception, CLIENT_DISCONNECT_ERRORS):
        return
    ThreadingHTTPServer.handle_error(server, request, client_address)


def _open_browser(url: str) -> None:
    launch_update = False
    try:
        if not webbrowser.open(url):
            LOGGER.warning("ブラウザを自動で開けませんでした。次のURLを開いてください: %s", url)
    except OSError:
        LOGGER.warning("ブラウザを自動で開けませんでした。次のURLを開いてください: %s", url)
    except Exception:
        LOGGER.exception("ブラウザを自動で開けませんでした。次のURLを開いてください: %s", url)


def _schedule_browser_open(url: str) -> threading.Timer:
    timer = threading.Timer(0.1, _open_browser, args=(url,))
    timer.daemon = True
    timer.start()
    return timer


def _startup_state(state_module):  # type: ignore[no-untyped-def]
    error = state_module.STATE_STARTUP_ERROR
    if error is not None:
        LOGGER.error("作業データを開けません。data\\workspaces.sqlite3 を退避してから、もう一度起動してください。")
        raise SystemExit(1)
    assert state_module.STATE is not None
    return state_module.STATE


def main() -> None:
    LOGGER.setLevel(logging.INFO)
    parser = argparse.ArgumentParser(description="Run Mozarie locally.")
    parser.add_argument("--port", type=int, default=None, help="Override the saved local port for this start only.")
    args = parser.parse_args()
    try:
        with MaintenanceLock(APP_DIR):
            global CLIENT_DISCONNECT_ERRORS
            import mozarie.state as state_module
            from mozarie.http import CLIENT_DISCONNECT_ERRORS, MosaicHandler
            state = _startup_state(state_module)
            port = args.port if args.port is not None else int(state.settings["general"]["port"])
            LOGGER.info("Mozarieを準備しています…")
            state.cache_dir.mkdir(parents=True, exist_ok=True)
            try:
                http_server = ThreadingHTTPServer(("127.0.0.1", port), MosaicHandler)
                http_server.handle_error = types.MethodType(_handle_server_error, http_server)
            except OSError:
                LOGGER.error("Mozarieを起動できません。ポート%sは使用中です。", port)
                state.shutdown()
                raise SystemExit(1) from None
            url = f"http://127.0.0.1:{port}"
            LOGGER.info("Mozarieを起動しました: %s", url)
            if state.settings["general"]["open_browser"]:
                _schedule_browser_open(url)
            try:
                http_server.serve_forever()
            except KeyboardInterrupt:
                pass
            finally:
                http_server.server_close()
                state.shutdown()
                LOGGER.info("Mozarieを終了しました")
            launch_update = bool(getattr(http_server, "mozarie_update_requested", False))
    except UpdateError:
        LOGGER.error("Mozarie is busy with setup or update. / setupまたは更新が完了してから起動してください。")
        raise SystemExit(1) from None
    if launch_update:
        import subprocess
        subprocess.Popen([str(APP_DIR / "update.bat")], cwd=str(APP_DIR), creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0))


if __name__ == "__main__":
    main()
