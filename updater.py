from __future__ import annotations

import json
import msvcrt
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any, Callable


APP_DIR = Path(__file__).resolve().parent
RELEASE_API = "https://api.github.com/repos/norqis/mozarie/releases/latest"
MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
MAX_ARCHIVE_FILES = 10_000

MANAGED_DIRECTORIES = ("mozarie", "static", "tests")
MANAGED_FILES = (
    ".gitattributes",
    ".gitignore",
    "LICENSE",
    "README.ja.md",
    "README.md",
    "requirements.txt",
    "run.bat",
    "server.py",
    "THIRD_PARTY_NOTICES.md",
    "VERSION",
    "updater.py",
    "config/defaults.json",
)

EXIT_CURRENT = 0
EXIT_ERROR = 1
EXIT_UPDATED = 10
EXIT_CANCELLED = 20


class UpdateError(RuntimeError):
    pass


def parse_version(value: str) -> tuple[int, int, int]:
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)", value.strip())
    if not match:
        raise UpdateError(f"バージョン表記が正しくありません: {value!r}")
    return tuple(int(part) for part in match.groups())


def display_version(value: str) -> str:
    major, minor, patch = parse_version(value)
    return f"v{major}.{minor}.{patch}"


def read_local_version(app_dir: Path = APP_DIR) -> str:
    path = app_dir / "VERSION"
    try:
        return path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise UpdateError("VERSIONファイルを読み込めません。") from exc


def fetch_latest_release(opener: Callable[..., Any] = urllib.request.urlopen) -> dict[str, Any]:
    request = urllib.request.Request(
        RELEASE_API,
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "Mozarie-Updater",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with opener(request, timeout=30) as response:
            payload = json.load(response)
    except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
        raise UpdateError("GitHubから更新情報を取得できませんでした。") from exc
    if not isinstance(payload, dict) or not isinstance(payload.get("tag_name"), str):
        raise UpdateError("GitHubの更新情報が正しくありません。")
    parse_version(payload["tag_name"])
    return payload


def release_download_url(release: dict[str, Any]) -> str:
    assets = release.get("assets")
    if isinstance(assets, list):
        zip_assets = [
            asset for asset in assets
            if isinstance(asset, dict)
            and isinstance(asset.get("name"), str)
            and asset["name"].lower().endswith(".zip")
            and isinstance(asset.get("browser_download_url"), str)
        ]
        preferred = next(
            (asset for asset in zip_assets if asset["name"].lower() in {"mozarie.zip", "mozarie-windows.zip"}),
            None,
        )
        if preferred is not None:
            return preferred["browser_download_url"]
    url = release.get("zipball_url")
    if not isinstance(url, str) or not url.startswith("https://"):
        raise UpdateError("ダウンロード先が見つかりません。")
    return url


def download_archive(url: str, destination: Path, opener: Callable[..., Any] = urllib.request.urlopen) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": "Mozarie-Updater"})
    try:
        with opener(request, timeout=60) as response, destination.open("wb") as output:
            total = 0
            while True:
                chunk = response.read(1024 * 1024)
                if not chunk:
                    break
                total += len(chunk)
                if total > MAX_ARCHIVE_BYTES:
                    raise UpdateError("更新ファイルが大きすぎます。")
                output.write(chunk)
                print(f"\rダウンロード中: {total // 1024 // 1024} MB", end="", flush=True)
    except UpdateError:
        raise
    except (OSError, urllib.error.URLError) as exc:
        raise UpdateError("更新ファイルをダウンロードできませんでした。") from exc
    print()


def _safe_member_path(info: zipfile.ZipInfo) -> PurePosixPath:
    name = info.filename
    if not name or "\x00" in name or "\\" in name:
        raise UpdateError("更新ZIPに不正なパスが含まれています。")
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise UpdateError("更新ZIPに不正なパスが含まれています。")
    mode = info.external_attr >> 16
    if stat.S_ISLNK(mode):
        raise UpdateError("更新ZIPにシンボリックリンクが含まれています。")
    return path


def extract_archive(archive: Path, destination: Path) -> Path:
    try:
        with zipfile.ZipFile(archive) as bundle:
            infos = bundle.infolist()
            if not infos or len(infos) > MAX_ARCHIVE_FILES:
                raise UpdateError("更新ZIPのファイル数が正しくありません。")
            if sum(info.file_size for info in infos) > MAX_ARCHIVE_BYTES:
                raise UpdateError("展開後の更新ファイルが大きすぎます。")
            for info in infos:
                relative = _safe_member_path(info)
                target = destination.joinpath(*relative.parts)
                if info.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                target.parent.mkdir(parents=True, exist_ok=True)
                with bundle.open(info) as source, target.open("wb") as output:
                    shutil.copyfileobj(source, output)
    except UpdateError:
        raise
    except (OSError, zipfile.BadZipFile, RuntimeError) as exc:
        raise UpdateError("更新ZIPを展開できませんでした。") from exc

    children = list(destination.iterdir())
    source_root = children[0] if len(children) == 1 and children[0].is_dir() else destination
    required = (source_root / "server.py", source_root / "run.bat", source_root / "mozarie", source_root / "static")
    if not all(path.exists() for path in required):
        raise UpdateError("更新ZIPにMozarie本体が見つかりません。")
    return source_root


def is_mozarie_running(app_dir: Path = APP_DIR) -> bool:
    cache_root = app_dir / ".mozarie-cache"
    if not cache_root.is_dir():
        return False
    for process_dir in cache_root.glob("process-*"):
        lock_path = process_dir / ".active.lock"
        if not lock_path.is_file():
            continue
        try:
            with lock_path.open("a+b") as handle:
                handle.seek(0)
                try:
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                except OSError:
                    return True
                else:
                    handle.seek(0)
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        except OSError:
            return True
    return False


def install_requirements(source_root: Path, app_dir: Path = APP_DIR) -> None:
    incoming = source_root / "requirements.txt"
    current = app_dir / "requirements.txt"
    if not incoming.is_file():
        return
    if current.is_file() and incoming.read_bytes() == current.read_bytes():
        return
    print("依存関係を更新しています...")
    result = subprocess.run(
        [sys.executable, "-m", "pip", "install", "-r", str(incoming)],
        cwd=str(app_dir),
        check=False,
    )
    if result.returncode != 0:
        raise UpdateError("依存関係の更新に失敗しました。本体は変更していません。")


def _remove_path(path: Path) -> None:
    if path.is_dir() and not path.is_symlink():
        shutil.rmtree(path)
    else:
        path.unlink(missing_ok=True)


def _copy_path(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    if source.is_dir():
        shutil.copytree(source, destination)
    else:
        shutil.copy2(source, destination)


def apply_update(source_root: Path, app_dir: Path = APP_DIR) -> None:
    managed = [*MANAGED_DIRECTORIES, *MANAGED_FILES]
    incoming = [relative for relative in managed if (source_root / relative).exists()]
    if "VERSION" not in incoming:
        raise UpdateError("更新ZIPにVERSIONファイルがありません。")

    with tempfile.TemporaryDirectory(prefix="mozarie-backup-") as temporary:
        backup_root = Path(temporary)
        backed_up: list[str] = []
        try:
            for relative in incoming:
                current = app_dir / relative
                if current.exists():
                    _copy_path(current, backup_root / relative)
                    backed_up.append(relative)
            for relative in incoming:
                current = app_dir / relative
                if current.exists():
                    _remove_path(current)
                _copy_path(source_root / relative, current)
        except Exception as exc:
            for relative in reversed(incoming):
                current = app_dir / relative
                if current.exists():
                    _remove_path(current)
            for relative in backed_up:
                current = app_dir / relative
                if current.exists():
                    _remove_path(current)
                _copy_path(backup_root / relative, current)
            if isinstance(exc, UpdateError):
                raise
            raise UpdateError("更新に失敗したため、元のファイルへ戻しました。") from exc


def perform_update(
    app_dir: Path = APP_DIR,
    *,
    opener: Callable[..., Any] = urllib.request.urlopen,
    input_fn: Callable[[str], str] = input,
) -> int:
    if is_mozarie_running(app_dir):
        raise UpdateError("Mozarieが起動中です。終了してからもう一度実行してください。")

    current_raw = read_local_version(app_dir)
    release = fetch_latest_release(opener)
    latest_raw = release["tag_name"]
    current = display_version(current_raw)
    latest = display_version(latest_raw)

    if parse_version(latest_raw) <= parse_version(current_raw):
        print(f"{current} は最新版です。")
        return EXIT_CURRENT

    print(f"{current} → {latest}")
    answer = input_fn("アップデートしますか？ [y/N]: ").strip().lower()
    if answer not in {"y", "yes"}:
        print("アップデートをキャンセルしました。")
        return EXIT_CANCELLED

    with tempfile.TemporaryDirectory(prefix="mozarie-update-") as temporary:
        workspace = Path(temporary)
        archive = workspace / "release.zip"
        extracted = workspace / "extracted"
        extracted.mkdir()
        print("更新ファイルをダウンロードしています...")
        download_archive(release_download_url(release), archive, opener)
        print("更新ファイルを確認しています...")
        source_root = extract_archive(archive, extracted)
        archive_version = read_local_version(source_root)
        if parse_version(archive_version) != parse_version(latest_raw):
            raise UpdateError("更新ZIPのバージョンがGitHub Releaseと一致しません。")
        install_requirements(source_root, app_dir)
        print("Mozarieを更新しています...")
        apply_update(source_root, app_dir)

    print(f"{current} → {latest}")
    print(f"{current} から {latest} へアップデートしました。")
    return EXIT_UPDATED


def main() -> int:
    try:
        return perform_update()
    except KeyboardInterrupt:
        print("\nアップデートをキャンセルしました。")
        return EXIT_CANCELLED
    except UpdateError as exc:
        print(f"エラー: {exc}", file=sys.stderr)
        return EXIT_ERROR
    except Exception as exc:
        print(f"予期しないエラー: {exc}", file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    raise SystemExit(main())
