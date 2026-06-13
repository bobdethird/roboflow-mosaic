#!/usr/bin/env python3
"""Thin, thread-safe Supabase client for the diversity pipeline.

Uses the project's secret key (server-side) against two surfaces:
  - PostgREST  (/rest/v1)     -> upsert rows into the youtube_videos / clips tables
  - Storage    (/storage/v1)  -> create a private bucket, upload clip mp4s + frames

DDL is NOT possible over these APIs, so the tables must be created once in the
Supabase SQL editor (see supabase_schema.sql). Until they exist, table upserts
no-op gracefully (logged once) and Storage uploads still work, so a run is never
blocked on the schema.

Env (loaded from ../.env, not overriding the shell):
  NEXT_PUBLIC_SUPABASE_URL   project URL
  SUPABASE_SECRET_KEY        secret/service key (sb_secret_...)
"""
from __future__ import annotations

import os
import threading
from pathlib import Path

import requests
from dotenv import load_dotenv

SCRIPT_DIR = Path(__file__).resolve().parent
load_dotenv(SCRIPT_DIR.parent / ".env")

BUCKET = os.environ.get("MOSAIC_CLIPS_BUCKET", "knicks-clips")


class Supabase:
    """Minimal REST wrapper. One instance is safe to share across threads."""

    def __init__(self):
        self.url = (os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or "").rstrip("/")
        self.key = (os.environ.get("SUPABASE_SECRET_KEY")
                    or os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or "").strip()
        self.enabled = bool(self.url and self.key)
        self._missing_tables: set[str] = set()
        self._lock = threading.Lock()
        # requests.Session is thread-safe for separate requests once configured.
        self._sess = requests.Session()
        self._sess.headers.update({"apikey": self.key,
                                   "Authorization": f"Bearer {self.key}"})

    # --- Storage ----------------------------------------------------------
    def ensure_bucket(self, bucket: str = BUCKET) -> bool:
        if not self.enabled:
            return False
        r = self._sess.get(f"{self.url}/storage/v1/bucket/{bucket}", timeout=20)
        if r.status_code == 200:
            return True
        r = self._sess.post(f"{self.url}/storage/v1/bucket", timeout=20,
                            json={"id": bucket, "name": bucket, "public": False})
        if r.status_code in (200, 201) or "already exists" in r.text.lower():
            return True
        print(f"  [supabase] bucket create failed: {r.status_code} {r.text[:160]}")
        return False

    def upload(self, object_path: str, data: bytes, content_type: str,
               bucket: str = BUCKET) -> bool:
        """Upsert a single object into the bucket."""
        if not self.enabled:
            return False
        url = f"{self.url}/storage/v1/object/{bucket}/{object_path}"
        headers = {"Content-Type": content_type, "x-upsert": "true",
                   "cache-control": "31536000"}
        r = self._sess.post(url, data=data, headers=headers, timeout=120)
        if r.status_code in (200, 201):
            return True
        print(f"  [supabase] upload {object_path} failed: {r.status_code} {r.text[:160]}")
        return False

    def upload_file(self, object_path: str, file_path: Path, content_type: str,
                    bucket: str = BUCKET) -> bool:
        try:
            return self.upload(object_path, file_path.read_bytes(), content_type, bucket)
        except OSError as e:
            print(f"  [supabase] read {file_path} failed: {e}")
            return False

    # --- PostgREST (tables) ----------------------------------------------
    def upsert(self, table: str, rows: list[dict], on_conflict: str) -> bool:
        """Upsert rows; no-op (logged once) if the table doesn't exist yet."""
        if not self.enabled or not rows:
            return False
        with self._lock:
            if table in self._missing_tables:
                return False
        url = f"{self.url}/rest/v1/{table}?on_conflict={on_conflict}"
        headers = {"Content-Type": "application/json",
                   "Prefer": "resolution=merge-duplicates,return=minimal"}
        try:
            r = self._sess.post(url, json=rows, headers=headers, timeout=30)
        except requests.RequestException as e:
            print(f"  [supabase] upsert {table} error: {e}")
            return False
        if r.status_code in (200, 201, 204):
            return True
        if r.status_code == 404 or "PGRST205" in r.text:
            with self._lock:
                if table not in self._missing_tables:
                    self._missing_tables.add(table)
                    print(f"  [supabase] table '{table}' missing — run "
                          f"supabase_schema.sql in the SQL editor to enable it. "
                          f"(Storage uploads still working.)")
            return False
        print(f"  [supabase] upsert {table} failed: {r.status_code} {r.text[:160]}")
        return False


# Module-level singleton for convenience.
_client: Supabase | None = None


def client() -> Supabase:
    global _client
    if _client is None:
        _client = Supabase()
    return _client


if __name__ == "__main__":
    c = client()
    print("enabled:", c.enabled, "url:", c.url)
    print("ensure bucket:", c.ensure_bucket())
