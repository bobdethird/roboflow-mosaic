#!/usr/bin/env python3
"""Pack existing Knicks thumbnail objects into atlas images.

This migration reads the already-published `knicks-mosaic` library from Supabase
Storage, fetches `thumbs/<id>.jpg` for every manifest photo into memory, uploads
versioned atlas JPEGs, and rewrites only `manifest.json` with `photo.thumb`
atlas rects. It does not write local thumbnail copies, depend on the old Knicks
ingestion pipeline, or delete standalone thumbnails, so old clients keep working
as a fallback.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote

import cv2
import numpy as np
import requests

try:
    from dotenv import load_dotenv as _load_dotenv
except ModuleNotFoundError:
    _load_dotenv = None


PIPELINE_ROOT = Path(__file__).resolve().parent
REPO_ROOT = PIPELINE_ROOT.parent
DEFAULT_BUCKET = "knicks-mosaic"
MANIFEST_PATH = "manifest.json"
ATLAS_DIR = "atlases"


@dataclass(frozen=True)
class Thumb:
    photo_index: int
    photo_id: str
    image: np.ndarray
    width: int
    height: int


@dataclass
class Atlas:
    path: str
    image: np.ndarray
    count: int


def load_environment() -> None:
    for env_path in (
        REPO_ROOT / ".env",
        REPO_ROOT / ".env.local",
        REPO_ROOT / "website" / ".env.local",
    ):
        if _load_dotenv is not None:
            _load_dotenv(env_path, override=False)
            continue
        if not env_path.exists():
            continue
        for line in env_path.read_text().splitlines():
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or "=" not in stripped:
                continue
            key, value = stripped.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def env_int(name: str, fallback: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return fallback
    try:
        return int(raw)
    except ValueError:
        return fallback


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Pack existing knicks-mosaic thumbs into atlas JPEGs.",
    )
    parser.add_argument("--bucket", default=os.environ.get("KNICKS_PHOTO_BUCKET", DEFAULT_BUCKET))
    parser.add_argument("--prefix", default=os.environ.get("KNICKS_PHOTO_LIBRARY_PREFIX", ""))
    parser.add_argument("--atlas-max", type=int, default=env_int("KNICKS_PHOTO_ATLAS_MAX", 2048))
    parser.add_argument(
        "--atlas-padding",
        type=int,
        default=env_int("KNICKS_PHOTO_ATLAS_PADDING", 2),
    )
    parser.add_argument(
        "--quality",
        type=int,
        default=env_int("KNICKS_PHOTO_THUMB_QUALITY", 82),
    )
    parser.add_argument("--workers", type=int, default=env_int("KNICKS_PHOTO_ATLAS_WORKERS", 12))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    args.prefix = clean_prefix(args.prefix)

    if args.atlas_max < 512:
        parser.error("--atlas-max must be at least 512")
    if args.atlas_padding < 0:
        parser.error("--atlas-padding must be non-negative")
    if args.quality < 1 or args.quality > 100:
        parser.error("--quality must be between 1 and 100")
    if args.workers < 1:
        parser.error("--workers must be at least 1")
    if not args.bucket:
        parser.error("--bucket is required")
    return args


def supabase_config() -> tuple[str, str]:
    url = (os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or "").rstrip("/")
    key = (
        os.environ.get("SUPABASE_SECRET_KEY", "").strip()
        or os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()
    )
    if not url:
        raise RuntimeError("Missing NEXT_PUBLIC_SUPABASE_URL in env/.env.local")
    if not key:
        raise RuntimeError("Missing SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY")
    return url, key


def clean_prefix(prefix: str) -> str:
    return "/".join(sanitize_segment(part) for part in prefix.split("/") if sanitize_segment(part))


def sanitize_segment(value: str, fallback: str = "") -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "-", str(value)).strip("-")[:140]
    return cleaned or fallback


def storage_path(prefix: str, object_path: str) -> str:
    return "/".join(part for part in (prefix, object_path) if part)


def encode_storage_path(path: str) -> str:
    return "/".join(quote(part, safe="") for part in path.split("/"))


def object_url(base_url: str, bucket: str, object_path: str) -> str:
    return f"{base_url}/storage/v1/object/{quote(bucket, safe='')}/{encode_storage_path(object_path)}"


def auth_headers(key: str, accept: str = "*/*") -> dict[str, str]:
    return {
        "apikey": key,
        "authorization": f"Bearer {key}",
        "accept": accept,
    }


def request_with_retry(
    method: str,
    url: str,
    *,
    attempts: int = 3,
    timeout: int = 60,
    **kwargs: Any,
) -> requests.Response:
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            response = requests.request(method, url, timeout=timeout, **kwargs)
            if response.ok:
                return response
            if response.status_code not in {408, 409, 425, 429, 500, 502, 503, 504}:
                response.raise_for_status()
            last_error = requests.HTTPError(
                f"{response.status_code} {response.reason}: {response.text[:180]}"
            )
        except requests.RequestException as error:
            last_error = error

        if attempt < attempts:
            time.sleep(0.75 * (2 ** (attempt - 1)))

    assert last_error is not None
    raise last_error


def download_bytes(base_url: str, key: str, bucket: str, object_path: str) -> bytes:
    response = request_with_retry(
        "GET",
        object_url(base_url, bucket, object_path),
        headers=auth_headers(key),
        timeout=60,
    )
    return response.content


def upload_bytes(
    base_url: str,
    key: str,
    bucket: str,
    object_path: str,
    data: bytes,
    content_type: str,
    *,
    dry_run: bool,
    cache_control: str = "31536000",
) -> None:
    if dry_run:
        return
    request_with_retry(
        "POST",
        object_url(base_url, bucket, object_path),
        data=data,
        headers={
            **auth_headers(key),
            "cache-control": cache_control,
            "content-type": content_type,
            "x-upsert": "true",
        },
        timeout=120,
    )


def download_manifest(base_url: str, key: str, bucket: str, prefix: str) -> dict[str, Any]:
    data = download_bytes(base_url, key, bucket, storage_path(prefix, MANIFEST_PATH))
    manifest = json.loads(data.decode("utf-8"))
    photos = manifest.get("photos")
    if not isinstance(photos, list) or not photos:
        raise RuntimeError("manifest.json does not contain photos")
    return manifest


def thumb_path(photo_id: str) -> str:
    return f"thumbs/{photo_id}.jpg"


def decode_thumb(photo_index: int, photo: dict[str, Any], data: bytes) -> Thumb:
    photo_id = str(photo.get("id") or "")
    if not photo_id:
        raise RuntimeError(f"manifest photo at index {photo_index} is missing id")
    arr = np.frombuffer(data, dtype=np.uint8)
    image = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if image is None:
        raise RuntimeError(f"Could not decode thumbnail for {photo_id}")
    height, width = image.shape[:2]
    return Thumb(
        photo_index=photo_index,
        photo_id=photo_id,
        image=image,
        width=width,
        height=height,
    )


def download_thumb(
    base_url: str,
    key: str,
    bucket: str,
    prefix: str,
    photo_index: int,
    photo: dict[str, Any],
) -> Thumb:
    photo_id = str(photo.get("id") or "")
    data = download_bytes(base_url, key, bucket, storage_path(prefix, thumb_path(photo_id)))
    return decode_thumb(photo_index, photo, data)


def atlas_path(version: str, index: int) -> str:
    segment = sanitize_segment(version, "library")
    return f"{ATLAS_DIR}/{segment}/thumbs-{index:04d}.jpg"


def pack_atlases(
    manifest: dict[str, Any],
    thumbs: list[Thumb],
    *,
    version: str,
    prefix: str,
    atlas_max: int,
    padding: int,
) -> list[Atlas]:
    photos = manifest["photos"]
    atlases: list[Atlas] = []
    canvas = np.zeros((atlas_max, atlas_max, 3), dtype=np.uint8)
    atlas_index = 0
    x = padding
    y = padding
    row_h = 0
    used_w = padding
    used_h = padding
    count = 0

    def flush() -> None:
        nonlocal canvas, atlas_index, x, y, row_h, used_w, used_h, count
        if count == 0:
            return
        cropped = canvas[: max(1, used_h), : max(1, used_w)].copy()
        atlases.append(Atlas(path=atlas_path(version, atlas_index), image=cropped, count=count))
        atlas_index += 1
        canvas = np.zeros((atlas_max, atlas_max, 3), dtype=np.uint8)
        x = padding
        y = padding
        row_h = 0
        used_w = padding
        used_h = padding
        count = 0

    for thumb in thumbs:
        if thumb.width + padding * 2 > atlas_max or thumb.height + padding * 2 > atlas_max:
            raise RuntimeError(
                f"Thumbnail {thumb.photo_id} ({thumb.width}x{thumb.height}) "
                f"does not fit atlas {atlas_max}px"
            )
        if x + thumb.width + padding > atlas_max:
            x = padding
            y += row_h + padding
            row_h = 0
        if y + thumb.height + padding > atlas_max and count > 0:
            flush()

        photo = photos[thumb.photo_index]
        current_path = atlas_path(version, atlas_index)
        photo["w"] = thumb.width
        photo["h"] = thumb.height
        photo["thumb"] = {
            "atlasPath": storage_path(prefix, current_path),
            "x": x,
            "y": y,
            "w": thumb.width,
            "h": thumb.height,
        }
        canvas[y : y + thumb.height, x : x + thumb.width] = thumb.image
        count += 1
        used_w = max(used_w, x + thumb.width + padding)
        used_h = max(used_h, y + thumb.height + padding)
        row_h = max(row_h, thumb.height)
        x += thumb.width + padding

    flush()
    return atlases


def encode_atlas(atlas: Atlas, quality: int) -> bytes:
    ok, encoded = cv2.imencode(".jpg", atlas.image, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise RuntimeError(f"Could not encode {atlas.path}")
    return encoded.tobytes()


def main(argv: list[str]) -> int:
    load_environment()
    args = parse_args(argv)
    base_url, key = supabase_config()
    manifest = download_manifest(base_url, key, args.bucket, args.prefix)
    previous_version = str(manifest.get("version") or "unknown")
    version = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    manifest["version"] = version

    print(
        f"Fetching {len(manifest['photos'])} thumbnails into memory from "
        f"{args.bucket}/{storage_path(args.prefix, 'thumbs')}"
    )
    thumbs: list[Thumb | None] = [None] * len(manifest["photos"])
    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [
            executor.submit(download_thumb, base_url, key, args.bucket, args.prefix, index, photo)
            for index, photo in enumerate(manifest["photos"])
        ]
        done = 0
        for future in as_completed(futures):
            thumb = future.result()
            thumbs[thumb.photo_index] = thumb
            done += 1
            if done % 250 == 0 or done == len(futures):
                print(f"  downloaded {done}/{len(futures)}")

    ordered_thumbs = [thumb for thumb in thumbs if thumb is not None]
    atlases = pack_atlases(
        manifest,
        ordered_thumbs,
        version=version,
        prefix=args.prefix,
        atlas_max=args.atlas_max,
        padding=args.atlas_padding,
    )

    print(
        f"Packed {len(ordered_thumbs)} thumbnails into {len(atlases)} atlas file(s) "
        f"(previous manifest version {previous_version})"
    )
    for atlas in atlases:
        data = encode_atlas(atlas, args.quality)
        print(f"  {'would upload' if args.dry_run else 'uploading'} {atlas.path} ({atlas.count} thumbs)")
        upload_bytes(
            base_url,
            key,
            args.bucket,
            storage_path(args.prefix, atlas.path),
            data,
            "image/jpeg",
            dry_run=args.dry_run,
        )

    manifest_bytes = json.dumps(manifest, indent=2).encode("utf-8")
    print(f"{'Would update' if args.dry_run else 'Updating'} {storage_path(args.prefix, MANIFEST_PATH)}")
    upload_bytes(
        base_url,
        key,
        args.bucket,
        storage_path(args.prefix, MANIFEST_PATH),
        manifest_bytes,
        "application/json",
        cache_control="60",
        dry_run=args.dry_run,
    )
    print(f"Done. Manifest version: {version}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
