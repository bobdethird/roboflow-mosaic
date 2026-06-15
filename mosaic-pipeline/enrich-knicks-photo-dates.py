#!/usr/bin/env python3
"""Backfill `takenAt` onto every photo in the knicks-mosaic Supabase manifest.

The /knicks-mosaic tiles are photos scraped from the NBA content API and grouped
into galleries. The published manifest (manifest.json in the `knicks-mosaic`
bucket) stores `gallery`/`galleryTitle`/`sourceUrl` per photo but no date — yet
the gallery scrape recorded an authoritative `published` timestamp for every
gallery. This script joins each photo to its gallery's publish date and writes it
back as `takenAt`, which the web matcher reads to bias selection toward recent /
playoff eras (see lib/mosaic-worker.ts).

Date source, in priority order:
  1. gallery publish date  (local gallery manifest, slug -> published)  [authoritative]
  2. sourceUrl date        (CDN path /YYYY/MM/ or legacy filename date) [fallback]

Usage:
  # Dry run against the live bucket (downloads manifest, reports, writes locally,
  # uploads nothing):
  python3 mosaic-pipeline/enrich-knicks-photo-dates.py

  # Dry run against a local manifest file (no network/key needed):
  python3 mosaic-pipeline/enrich-knicks-photo-dates.py --manifest path/to/manifest.json

  # Apply: enrich the live bucket manifest in place (preserves `version`):
  python3 mosaic-pipeline/enrich-knicks-photo-dates.py --apply

Credentials (only needed to download from / upload to the bucket) are read from
the environment or .env / .env.local: NEXT_PUBLIC_SUPABASE_URL and
SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PIPELINE_ROOT = Path(__file__).resolve().parent
REPO_ROOT = PIPELINE_ROOT.parent
DEFAULT_BUCKET = "knicks-mosaic"
MANIFEST_OBJECT = "manifest.json"
FALLBACK_SUPABASE_URL = "https://qnpwjltgxgkohtqhprux.supabase.co"
# Where the gallery scrape recorded slug -> published. Override with --galleries.
DEFAULT_GALLERY_MANIFEST = (
    REPO_ROOT / "deprecated" / "pipeline" / "data" / "knicks-photo-library-manifest.json"
)
DEFAULT_OUT_DIR = PIPELINE_ROOT / "data"

# sourceUrl date fallbacks (used only when a photo's gallery has no publish date).
RX_MODERN = re.compile(r"/sites/\d+/(\d{4})/(\d{2})/")
RX_LEGACY_SUFFIX = re.compile(r"_(?:nyk|nyc)_(\d{2})(\d{2})(\d{2})[_-]")
RX_LEGACY_PREFIX = re.compile(r"/(\d{2})(\d{2})(\d{2})_[a-z]{2,5}[_-]")


def load_env() -> None:
    """Populate os.environ from .env / .env.local without clobbering real vars."""
    for env_path in (
        REPO_ROOT / ".env",
        REPO_ROOT / ".env.local",
        REPO_ROOT / "website" / ".env.local",
    ):
        if not env_path.exists():
            continue
        for line in env_path.read_text().splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            os.environ.setdefault(key, value)


def supabase_creds() -> tuple[str, str]:
    url = (os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or FALLBACK_SUPABASE_URL).rstrip("/")
    key = (
        os.environ.get("SUPABASE_SECRET_KEY")
        or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or ""
    ).strip()
    return url, key


def storage_download(url: str, key: str, bucket: str, obj: str) -> bytes:
    headers = {"apikey": key, "Authorization": f"Bearer {key}"}
    last_error = ""
    for endpoint in (
        f"{url}/storage/v1/object/authenticated/{bucket}/{obj}",
        f"{url}/storage/v1/object/{bucket}/{obj}",
    ):
        req = urllib.request.Request(endpoint, headers=headers, method="GET")
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return resp.read()
        except urllib.error.HTTPError as exc:
            last_error = f"{exc.code} {exc.reason}"
        except urllib.error.URLError as exc:
            last_error = str(exc.reason)
    raise SystemExit(f"Failed to download {bucket}/{obj}: {last_error}")


def storage_upload(url: str, key: str, bucket: str, obj: str, body: bytes) -> None:
    endpoint = f"{url}/storage/v1/object/{bucket}/{obj}"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "x-upsert": "true",
        "cache-control": "max-age=60",
    }
    req = urllib.request.Request(endpoint, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:240]
        raise SystemExit(f"Upload failed ({exc.code} {exc.reason}): {detail}")
    except urllib.error.URLError as exc:
        raise SystemExit(f"Upload failed: {exc.reason}")


def build_slug_to_published(gallery_manifest: Path) -> dict[str, str]:
    if not gallery_manifest.exists():
        print(f"  (no gallery manifest at {gallery_manifest}; using sourceUrl only)")
        return {}
    data = json.loads(gallery_manifest.read_text())
    out: dict[str, str] = {}
    for gallery in data.get("galleries", []):
        slug = gallery.get("slug")
        published = gallery.get("published")
        if slug and published:
            out[slug] = published
    return out


def date_from_source_url(source_url: str) -> str | None:
    m = RX_MODERN.search(source_url)
    if m:
        return f"{int(m.group(1)):04d}-{int(m.group(2)):02d}-01T00:00:00Z"
    m = RX_LEGACY_SUFFIX.search(source_url)
    if m:
        mo, dd, yy = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if 1 <= mo <= 12 and 1 <= dd <= 31:
            return f"{2000 + yy:04d}-{mo:02d}-{dd:02d}T00:00:00Z"
    m = RX_LEGACY_PREFIX.search(source_url)
    if m:
        yy, mo, dd = int(m.group(1)), int(m.group(2)), int(m.group(3))
        if 1 <= mo <= 12 and 1 <= dd <= 31:
            return f"{2000 + yy:04d}-{mo:02d}-{dd:02d}T00:00:00Z"
    return None


def classify_tier(taken_at: str | None, now: datetime) -> str:
    if not taken_at:
        return "unknown"
    try:
        dt = datetime.fromisoformat(taken_at.replace("Z", "+00:00"))
    except ValueError:
        return "unknown"
    if dt.year in (2025, 2026) and dt.month in (4, 5, 6):
        return "playoff"
    months = (now.year - dt.year) * 12 + (now.month - dt.month)
    if months <= 24:
        return "recent"
    return "rest"


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--bucket", default=DEFAULT_BUCKET)
    parser.add_argument(
        "--galleries",
        type=Path,
        default=DEFAULT_GALLERY_MANIFEST,
        help="local gallery manifest with slug -> published",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=None,
        help="read this local manifest.json instead of downloading from the bucket",
    )
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument(
        "--apply",
        action="store_true",
        help="upload the enriched manifest back to the bucket (otherwise dry run)",
    )
    parser.add_argument(
        "--bump-version",
        action="store_true",
        help="set manifest.version to now (forces clients to re-download signatures)",
    )
    parser.add_argument(
        "--overwrite-existing",
        action="store_true",
        help="recompute takenAt even for photos that already have one",
    )
    args = parser.parse_args(argv)

    load_env()
    args.out_dir.mkdir(parents=True, exist_ok=True)

    print(f"Gallery dates: {args.galleries}")
    slug_to_pub = build_slug_to_published(args.galleries)
    print(f"  {len(slug_to_pub)} galleries with a publish date")

    if args.manifest is not None:
        print(f"Manifest: {args.manifest} (local)")
        manifest = json.loads(args.manifest.read_text())
    else:
        url, key = supabase_creds()
        if not key:
            raise SystemExit(
                "No Supabase key. Set SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY "
                "in the environment or .env.local, or pass --manifest <file>."
            )
        print(f"Manifest: downloading {args.bucket}/{MANIFEST_OBJECT} from {url}")
        manifest = json.loads(storage_download(url, key, args.bucket, MANIFEST_OBJECT))
        before_path = args.out_dir / "knicks-mosaic-manifest.before.json"
        before_path.write_text(json.dumps(manifest))
        print(f"  saved pre-image to {before_path}")

    photos = manifest.get("photos", [])
    if not photos:
        raise SystemExit("Manifest has no photos.")

    now = datetime.now(timezone.utc)
    source_counts: Counter[str] = Counter()
    tier_counts: Counter[str] = Counter()
    for photo in photos:
        if photo.get("takenAt") and not args.overwrite_existing:
            source_counts["already-present"] += 1
        else:
            taken_at = slug_to_pub.get(photo.get("gallery", ""))
            if taken_at:
                source_counts["gallery"] += 1
            else:
                taken_at = date_from_source_url(photo.get("sourceUrl", ""))
                source_counts["sourceUrl" if taken_at else "none"] += 1
            if taken_at:
                photo["takenAt"] = taken_at
        tier_counts[classify_tier(photo.get("takenAt"), now)] += 1

    if args.bump_version:
        manifest["version"] = now.strftime("%Y-%m-%dT%H:%M:%S.000Z")

    n = len(photos)
    print(f"\nPhotos: {n}")
    print("  takenAt source:")
    for k in ("gallery", "sourceUrl", "already-present", "none"):
        if source_counts[k]:
            print(f"    {k:16s} {source_counts[k]:6d}  {source_counts[k] / n:5.1%}")
    print("  resulting tier split:")
    for k in ("playoff", "recent", "rest", "unknown"):
        if tier_counts[k]:
            print(f"    {k:16s} {tier_counts[k]:6d}  {tier_counts[k] / n:5.1%}")

    enriched_path = args.out_dir / "knicks-mosaic-manifest.enriched.json"
    enriched_path.write_text(json.dumps(manifest))
    print(f"\nWrote enriched manifest to {enriched_path}")

    if not args.apply:
        print("Dry run — nothing uploaded. Re-run with --apply to update the bucket.")
        return 0

    url, key = supabase_creds()
    if not key:
        raise SystemExit("Cannot --apply without a Supabase key.")
    body = json.dumps(manifest).encode("utf-8")
    print(f"Uploading {args.bucket}/{MANIFEST_OBJECT} ({len(body) / 1e6:.1f} MB)…")
    storage_upload(url, key, args.bucket, MANIFEST_OBJECT, body)
    print("Done. The /knicks-mosaic page will pick up takenAt on next load.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        print("\nInterrupted.", file=sys.stderr)
        raise SystemExit(130)
