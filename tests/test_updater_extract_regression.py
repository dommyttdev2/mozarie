"""Regression coverage for update archive extraction storage checks."""

from __future__ import annotations

import tempfile
import unittest
import zipfile
from pathlib import Path

import updater


class UpdaterExtractRegressionTests(unittest.TestCase):
    def test_extract_archive_allows_a_missing_destination_directory(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive = root / "release.zip"
            source_name = "Mozarie-release"
            with zipfile.ZipFile(archive, "w") as bundle:
                bundle.writestr(f"{source_name}/", b"")
                for directory in updater.MANAGED_DIRECTORIES:
                    bundle.writestr(f"{source_name}/{directory}/", b"")
                for filename in updater.MANAGED_FILES:
                    bundle.writestr(f"{source_name}/{filename}", b"release")
            destination = root / "not-created" / "extract"
            installed = root / "installed"
            installed.mkdir()
            extracted = updater.extract_archive(archive, destination, installed)
            self.assertEqual(extracted, destination / source_name)
            self.assertTrue(extracted.is_dir())
            self.assertTrue((extracted / "VERSION").is_file())


if __name__ == "__main__":
    unittest.main()
