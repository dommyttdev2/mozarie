import atexit
import os
import shutil
import tempfile
import warnings
from pathlib import Path


warnings.filterwarnings(
    "error",
    category=DeprecationWarning,
    module=r"^(?:(?:PIL|mozarie|tests)(?:\.|$)|server$|updater$)",
)


# Importing mozarie.state creates the process state.  Give every test process a
# complete disposable app directory before that import so discovery can never
# create config, data, cache, output, or SQLite files in the checkout.
_SOURCE_ROOT = Path(__file__).resolve().parents[1]
_configured_app_dir = os.environ.get("MOZARIE_TEST_APP_DIR")
TEST_APP_DIR = Path(_configured_app_dir) if _configured_app_dir else Path(tempfile.mkdtemp(prefix="mozarie-tests-"))
TEST_APP_DIR.mkdir(parents=True, exist_ok=True)
shutil.copytree(_SOURCE_ROOT / "config", TEST_APP_DIR / "config")
(TEST_APP_DIR / "config" / "local.json").unlink(missing_ok=True)
if not _configured_app_dir:
    atexit.register(shutil.rmtree, TEST_APP_DIR, ignore_errors=True)

import mozarie.core as _core  # noqa: E402

_core.APP_DIR = TEST_APP_DIR
_core.CACHE_BASE_DIR = TEST_APP_DIR / ".mozarie-cache"
_core.SESSION_BASE_DIR = TEST_APP_DIR / ".sessions"

# These entry points are exercised directly by a few tests.  Their defaults
# must point at the same disposable app directory as the process state.
import server as _server  # noqa: E402

_server.APP_DIR = TEST_APP_DIR
