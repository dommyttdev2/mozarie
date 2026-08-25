"""Small durable catalogue store.

The process cache deliberately remains disposable.  Only the review work that
cannot be reconstructed from the source images is written here.
"""

from __future__ import annotations

import hashlib
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import Any


class _ClosingConnection(sqlite3.Connection):
    """sqlite's context manager commits but does not close on Windows."""
    def __exit__(self, *args: Any) -> None:
        super().__exit__(*args)
        self.close()


class WorkspaceStore:
    VERSION = 2

    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / "workspaces.sqlite3"
        self._lock = threading.RLock()
        data_dir.mkdir(parents=True, exist_ok=True)
        with self._connect() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.execute("PRAGMA synchronous=NORMAL")
            db.execute("PRAGMA foreign_keys=ON")
            db.execute("PRAGMA busy_timeout=5000")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS catalogs (
                    catalog_id TEXT PRIMARY KEY, identity_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS images (
                    catalog_id TEXT NOT NULL REFERENCES catalogs(catalog_id) ON DELETE CASCADE,
                    relative_path TEXT NOT NULL, image_id TEXT NOT NULL UNIQUE,
                    size_bytes INTEGER NOT NULL, mtime_ns INTEGER NOT NULL, source_hash TEXT NOT NULL DEFAULT '',
                    hidden INTEGER NOT NULL DEFAULT 0, reviewed INTEGER NOT NULL DEFAULT 0,
                    candidate_revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
                    PRIMARY KEY(catalog_id, relative_path)
                );
                CREATE TABLE IF NOT EXISTS candidates (
                    image_id TEXT NOT NULL REFERENCES images(image_id) ON DELETE CASCADE,
                    candidate_id TEXT NOT NULL, class_name TEXT NOT NULL, confidence REAL,
                    mask_png BLOB NOT NULL, enabled INTEGER NOT NULL, color TEXT NOT NULL,
                    source TEXT NOT NULL, origin TEXT NOT NULL, refinement TEXT,
                    role TEXT NOT NULL, forced INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY(image_id, candidate_id)
                );
                CREATE TABLE IF NOT EXISTS manual_edits (
                    image_id TEXT PRIMARY KEY REFERENCES images(image_id) ON DELETE CASCADE,
                    add_png BLOB, exclusion_png BLOB, exclusion_erase_png BLOB,
                    manual_enabled INTEGER NOT NULL DEFAULT 1,
                    exclusion_enabled INTEGER NOT NULL DEFAULT 1,
                    exclusion_erase_enabled INTEGER NOT NULL DEFAULT 1,
                    exclusion_forced INTEGER NOT NULL DEFAULT 1,
                    removed_candidate_ids TEXT NOT NULL DEFAULT '[]', candidate_revision INTEGER NOT NULL DEFAULT 0,
                    updated_at INTEGER NOT NULL
                );
            """)
            # A process cannot own an upload that survived a restart. These
            # partial browser manifests are never safe restoration targets.
            db.execute("DELETE FROM catalogs WHERE identity_hash LIKE 'browser-provisional:%'")
            columns = {row["name"] for row in db.execute("PRAGMA table_info(images)")}
            if "source_hash" not in columns:
                db.execute("ALTER TABLE images ADD COLUMN source_hash TEXT NOT NULL DEFAULT ''")
            version_row = db.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
            if version_row and int(version_row["value"]) > self.VERSION:
                raise RuntimeError("workspace database is newer than this Mozarie version")
            db.execute("INSERT OR REPLACE INTO meta(key, value) VALUES('schema_version', ?)", (str(self.VERSION),))

    def _connect(self) -> sqlite3.Connection:
        db = sqlite3.connect(self.path, timeout=5, isolation_level=None, factory=_ClosingConnection)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=5000")
        return db

    @staticmethod
    def identity_for_root(root: Path) -> str:
        return hashlib.sha256(str(root.resolve()).casefold().encode("utf-8")).hexdigest()

    def catalog_for_root(self, root: Path) -> str:
        identity = self.identity_for_root(root)
        now = time.time_ns()
        with self._lock, self._connect() as db:
            row = db.execute("SELECT catalog_id FROM catalogs WHERE identity_hash=?", (identity,)).fetchone()
            if row:
                db.execute("UPDATE catalogs SET updated_at=? WHERE catalog_id=?", (now, row["catalog_id"]))
                return str(row["catalog_id"])
            catalog_id = uuid.uuid4().hex
            db.execute("INSERT INTO catalogs VALUES(?,?,?,?)", (catalog_id, identity, now, now))
            return catalog_id

    def ensure_catalog(self, catalog_id: str | None = None) -> str:
        """Create (or validate) an opaque browser catalogue identity."""
        if catalog_id is not None and (len(catalog_id) != 32 or any(char not in "0123456789abcdef" for char in catalog_id)):
            raise ValueError("invalid catalog id")
        catalog_id = catalog_id or uuid.uuid4().hex
        identity = f"browser:{catalog_id}"
        now = time.time_ns()
        with self._lock, self._connect() as db:
            db.execute("INSERT OR IGNORE INTO catalogs(catalog_id,identity_hash,created_at,updated_at) VALUES(?,?,?,?)", (catalog_id, identity, now, now))
            return catalog_id

    def ensure_provisional_catalog(self) -> str:
        catalog_id = uuid.uuid4().hex
        now = time.time_ns()
        with self._lock, self._connect() as db:
            db.execute("INSERT INTO catalogs(catalog_id,identity_hash,created_at,updated_at) VALUES(?,?,?,?)", (catalog_id, f"browser-provisional:{catalog_id}", now, now))
        return catalog_id

    def finalize_catalog(self, catalog_id: str) -> None:
        with self._lock, self._connect() as db:
            db.execute("UPDATE catalogs SET identity_hash=?,updated_at=? WHERE catalog_id=? AND identity_hash LIKE 'browser-provisional:%'", (f"browser:{catalog_id}", time.time_ns(), catalog_id))

    def catalog_exists(self, catalog_id: str) -> bool:
        with self._connect() as db:
            return db.execute("SELECT 1 FROM catalogs WHERE catalog_id=?", (catalog_id,)).fetchone() is not None

    def delete_catalog(self, catalog_id: str) -> None:
        """Remove an unused provisional browser catalogue and its cascaded rows."""
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                db.execute("DELETE FROM catalogs WHERE catalog_id=?", (catalog_id,))
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise

    def unique_catalog_for_file(self, relative_path: str, source_hash: str) -> str | None:
        if not source_hash: return None
        with self._connect() as db:
            rows = db.execute("SELECT DISTINCT catalog_id FROM images WHERE relative_path=? AND source_hash=?", (relative_path, source_hash)).fetchall()
        return str(rows[0]["catalog_id"]) if len(rows) == 1 else None

    def best_catalog_for_manifest(self, entries: list[tuple[str, str]], exclude_catalog: str) -> str | None:
        """Return a browser catalogue only for a unique strict-majority match."""
        scores: dict[str, int] = {}
        counts: dict[str, int] = {}
        with self._connect() as db:
            for relative_path, source_hash in entries:
                for row in db.execute("""SELECT images.catalog_id
                    FROM images JOIN catalogs ON catalogs.catalog_id=images.catalog_id
                    WHERE images.relative_path=? AND images.source_hash=? AND images.catalog_id<>?
                      AND catalogs.identity_hash LIKE 'browser:%'""", (relative_path, source_hash, exclude_catalog)):
                    scores[str(row["catalog_id"])] = scores.get(str(row["catalog_id"]), 0) + 1
            for row in db.execute("""SELECT catalogs.catalog_id, COUNT(images.image_id) AS image_count
                FROM catalogs JOIN images ON images.catalog_id=catalogs.catalog_id
                WHERE catalogs.identity_hash LIKE 'browser:%' AND catalogs.catalog_id<>?
                GROUP BY catalogs.catalog_id""", (exclude_catalog,)):
                counts[str(row["catalog_id"])] = int(row["image_count"])
        if not scores: return None
        best = max(scores.values())
        winners = [catalog_id for catalog_id, score in scores.items() if score == best]
        if len(winners) != 1:
            return None
        target = winners[0]
        # A one-image folder is safe only when both complete manifests are
        # exactly that one image. Larger folders require strict majority on
        # both sides, preventing two common files from joining a 100-image set.
        if best == len(entries) == counts.get(target, 0) == 1:
            return target
        return target if best * 2 > max(len(entries), counts.get(target, 0)) else None

    def reconcile_images(self, catalog_id: str, records: list[Any], source_hashes: dict[str, str] | None = None) -> dict[str, dict[str, Any]]:
        """Return durable state by relative path, clearing pixels on source change."""
        now = time.time_ns()
        result: dict[str, dict[str, Any]] = {}
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                for record in records:
                    row = db.execute("SELECT * FROM images WHERE catalog_id=? AND relative_path=?", (catalog_id, record.relative_path)).fetchone()
                    source_hash = (source_hashes or {}).get(record.relative_path, "")
                    if row is None:
                        image_id = uuid.uuid4().hex
                        db.execute("INSERT INTO images(catalog_id,relative_path,image_id,size_bytes,mtime_ns,source_hash,updated_at) VALUES(?,?,?,?,?,?,?)",
                                   (catalog_id, record.relative_path, image_id, record.size_bytes, record.mtime_ns, source_hash, now))
                        result[record.relative_path] = {"image_id": image_id, "hidden": False, "reviewed": False, "revision": 0, "changed": False}
                        continue
                    changed = (bool(source_hash) and row["source_hash"] != source_hash) or (not source_hash and (int(row["size_bytes"]) != record.size_bytes or int(row["mtime_ns"]) != record.mtime_ns))
                    if changed:
                        db.execute("UPDATE images SET size_bytes=?,mtime_ns=?,source_hash=?,reviewed=0,candidate_revision=0,updated_at=? WHERE image_id=?",
                                   (record.size_bytes, record.mtime_ns, source_hash, now, row["image_id"]))
                        db.execute("DELETE FROM candidates WHERE image_id=?", (row["image_id"],))
                        db.execute("DELETE FROM manual_edits WHERE image_id=?", (row["image_id"],))
                    result[record.relative_path] = {"image_id": row["image_id"], "hidden": bool(row["hidden"]), "reviewed": False if changed else bool(row["reviewed"]), "revision": 0 if changed else int(row["candidate_revision"]), "changed": changed}
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK")
                raise
        return result

    def image_state(self, image_id: str) -> tuple[bool, bool]:
        with self._connect() as db:
            row = db.execute("SELECT hidden,reviewed FROM images WHERE image_id=?", (image_id,)).fetchone()
            return (bool(row["hidden"]), bool(row["reviewed"])) if row else (False, False)

    def has_image(self, image_id: str) -> bool:
        with self._connect() as db:
            return db.execute("SELECT 1 FROM images WHERE image_id=?", (image_id,)).fetchone() is not None

    def set_image_flags(self, image_id: str, *, hidden: bool | None = None, reviewed: bool | None = None) -> None:
        updates: list[str] = []; values: list[Any] = []
        if hidden is not None: updates.append("hidden=?"); values.append(int(hidden))
        if reviewed is not None: updates.append("reviewed=?"); values.append(int(reviewed))
        if not updates: return
        values.extend([time.time_ns(), image_id])
        with self._lock, self._connect() as db:
            db.execute(f"UPDATE images SET {','.join(updates)},updated_at=? WHERE image_id=?", values)

    def replace_candidates(self, image_id: str, revision: int, candidates: list[Any]) -> None:
        with self._lock, self._connect() as db:
            db.execute("BEGIN IMMEDIATE")
            try:
                db.execute("UPDATE images SET candidate_revision=?, reviewed=0, updated_at=? WHERE image_id=?", (revision, time.time_ns(), image_id))
                db.execute("UPDATE candidates SET deleted=1 WHERE image_id=?", (image_id,))
                for candidate in candidates:
                    try:
                        with candidate.mask_path.open("rb") as handle:
                            mask = handle.read()
                    except OSError:
                        # Restored candidates intentionally do not materialise
                        # every PNG.  Keep their existing durable mask while
                        # updating just the requested metadata.
                        row = db.execute(
                            "SELECT mask_png FROM candidates WHERE image_id=? AND candidate_id=?",
                            (image_id, candidate.candidate_id),
                        ).fetchone()
                        mask = row["mask_png"] if row else None
                        if not isinstance(mask, bytes) or not mask.startswith(b"\x89PNG\r\n\x1a\n"):
                            continue
                    db.execute("""INSERT INTO candidates(image_id,candidate_id,class_name,confidence,mask_png,enabled,color,source,origin,refinement,role,forced,deleted)
                        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,0)
                        ON CONFLICT(image_id,candidate_id) DO UPDATE SET class_name=excluded.class_name,confidence=excluded.confidence,mask_png=excluded.mask_png,enabled=excluded.enabled,color=excluded.color,source=excluded.source,origin=excluded.origin,refinement=excluded.refinement,role=excluded.role,forced=excluded.forced,deleted=0""",
                        (image_id,candidate.candidate_id,candidate.class_name,candidate.confidence,mask,int(candidate.enabled),candidate.color,candidate.source,candidate.origin,candidate.refinement,candidate.role.value,int(candidate.forced)))
                db.execute("DELETE FROM candidates WHERE image_id=? AND deleted=1", (image_id,))
                db.execute("COMMIT")
            except Exception:
                db.execute("ROLLBACK"); raise

    def hydrate_candidates(self, image_id: str, directory: Path, candidate_factory: Any) -> tuple[int, list[Any]]:
        with self._connect() as db:
            image = db.execute("SELECT candidate_revision FROM images WHERE image_id=?", (image_id,)).fetchone()
            rows = db.execute("""SELECT candidate_id,class_name,confidence,enabled,color,source,origin,refinement,role,forced,
                length(mask_png) AS mask_size,substr(mask_png,1,8) AS mask_signature
                FROM candidates WHERE image_id=? AND deleted=0""", (image_id,)).fetchall()
        if not image: return 0, []
        if not rows: return int(image["candidate_revision"]), []
        candidates = []
        for row in rows:
            if int(row["mask_size"] or 0) < 8 or row["mask_signature"] != b"\x89PNG\r\n\x1a\n": continue
            path = directory / f"{row['candidate_id']}.png"
            candidates.append(candidate_factory(row, path))
        return int(image["candidate_revision"]), candidates

    def valid_candidate_ids(self, image_id: str) -> set[str]:
        with self._connect() as db:
            rows = db.execute("""SELECT candidate_id FROM candidates
                WHERE image_id=? AND deleted=0 AND length(mask_png)>=8
                  AND substr(mask_png,1,8)=?""", (image_id, b"\x89PNG\r\n\x1a\n")).fetchall()
        return {str(row["candidate_id"]) for row in rows}

    def candidate_png(self, image_id: str, candidate_id: str) -> bytes | None:
        with self._connect() as db:
            row = db.execute("SELECT mask_png FROM candidates WHERE image_id=? AND candidate_id=? AND deleted=0", (image_id, candidate_id)).fetchone()
        raw = row["mask_png"] if row else None
        return raw if isinstance(raw, bytes) and raw.startswith(b"\x89PNG\r\n\x1a\n") else None

    def save_manual(self, image_id: str, payload: dict[str, Any], decoder: Any) -> None:
        add, exclusion, erase = (decoder(payload.get(key)) for key in ("add", "exclusion", "exclusionErase"))
        removed = payload.get("removedCandidateIds", [])
        if not isinstance(removed, list) or any(not isinstance(item, str) for item in removed): raise ValueError("invalid removed candidates")
        with self._lock, self._connect() as db:
            db.execute("""INSERT INTO manual_edits VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(image_id) DO UPDATE SET
                add_png=excluded.add_png,exclusion_png=excluded.exclusion_png,exclusion_erase_png=excluded.exclusion_erase_png,
                manual_enabled=excluded.manual_enabled,exclusion_enabled=excluded.exclusion_enabled,exclusion_erase_enabled=excluded.exclusion_erase_enabled,
                exclusion_forced=excluded.exclusion_forced,removed_candidate_ids=excluded.removed_candidate_ids,candidate_revision=excluded.candidate_revision,updated_at=excluded.updated_at""",
                (image_id,add,exclusion,erase,int(payload.get("manualEnabled", True)),int(payload.get("manualExclusionEnabled", True)),int(payload.get("manualExclusionEraseEnabled", True)),int(payload.get("manualExclusionForced", True)),__import__('json').dumps(removed),int(payload.get("candidateRevision", 0)),time.time_ns()))

    def delete_manual(self, image_ids: list[str]) -> None:
        if not image_ids:
            return
        placeholders = ",".join("?" for _ in image_ids)
        with self._lock, self._connect() as db:
            db.execute(f"DELETE FROM manual_edits WHERE image_id IN ({placeholders})", image_ids)

    def manual(self, image_id: str, encoder: Any) -> dict[str, Any] | None:
        with self._connect() as db: row = db.execute("SELECT * FROM manual_edits WHERE image_id=?", (image_id,)).fetchone()
        if not row: return None
        try:
            return {"add": encoder(row["add_png"]), "exclusion": encoder(row["exclusion_png"]), "exclusionErase": encoder(row["exclusion_erase_png"]), "manualEnabled": bool(row["manual_enabled"]), "manualExclusionEnabled": bool(row["exclusion_enabled"]), "manualExclusionEraseEnabled": bool(row["exclusion_erase_enabled"]), "manualExclusionForced": bool(row["exclusion_forced"]), "removedCandidateIds": __import__('json').loads(row["removed_candidate_ids"]), "candidateRevision": int(row["candidate_revision"])}
        except Exception: return None
