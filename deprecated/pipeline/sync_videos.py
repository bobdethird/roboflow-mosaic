#!/usr/bin/env python3
"""Sync source videos from Supabase into pipeline/videos/ — but only what's
missing. Pulls the canonical youtube_videos.csv from the bucket, cross-checks
every video id against the local videos folder, and downloads from Supabase
ONLY the ones not already on disk. Videos already local are left untouched.

The mosaic/index pipeline then always reads from pipeline/videos/ (local).

  python sync_videos.py
"""
from __future__ import annotations

import csv
import io
from pathlib import Path

import supabase_push

VIDEOS = Path(__file__).resolve().parent / "videos"
CSV_LOCAL = Path(__file__).resolve().parent / "youtube_videos.csv"


def list_bucket_videos(sb) -> list[str]:
    names, off = [], 0
    while True:
        r = sb._sess.post(
            f"{sb.url}/storage/v1/object/list/{supabase_push.BUCKET}",
            json={"prefix": "videos", "limit": 1000, "offset": off}, timeout=30)
        page = r.json() if r.status_code == 200 else []
        if not page:
            break
        names += [x["name"] for x in page if x.get("name", "").endswith(".mp4")]
        if len(page) < 1000:
            break
        off += 1000
    return names


def download_csv(sb) -> list[str]:
    """Pull youtube_videos.csv from the bucket; return the video_ids in it."""
    r = sb._sess.get(
        f"{sb.url}/storage/v1/object/{supabase_push.BUCKET}/youtube_videos.csv",
        timeout=30)
    if r.status_code != 200:
        print(f"  (no youtube_videos.csv in bucket: {r.status_code})")
        return []
    CSV_LOCAL.write_bytes(r.content)
    rows = list(csv.DictReader(io.StringIO(r.text)))
    print(f"  pulled youtube_videos.csv ({len(rows)} rows) -> {CSV_LOCAL.name}")
    return [row["video_id"] for row in rows if row.get("video_id")]


def download_video(sb, name: str) -> bool:
    dst = VIDEOS / name
    url = f"{sb.url}/storage/v1/object/{supabase_push.BUCKET}/videos/{name}"
    with sb._sess.get(url, stream=True, timeout=3600) as r:
        if r.status_code != 200:
            print(f"  ✗ {name}: {r.status_code}")
            return False
        tmp = dst.with_suffix(".mp4.part")
        with tmp.open("wb") as f:
            for chunk in r.iter_content(chunk_size=1 << 20):
                f.write(chunk)
        tmp.replace(dst)
    print(f"  ↓ pulled {name} ({dst.stat().st_size/1e6:.0f} MB)")
    return True


def main() -> int:
    VIDEOS.mkdir(parents=True, exist_ok=True)
    sb = supabase_push.client()
    if not sb.enabled:
        print("Supabase not configured")
        return 1

    csv_ids = set(download_csv(sb))
    bucket_files = list_bucket_videos(sb)
    bucket_ids = {Path(n).stem for n in bucket_files}
    # Canonical id set = union of CSV ids and actual files in the bucket.
    all_ids = csv_ids | bucket_ids
    print(f"  bucket videos/: {len(bucket_files)} files | csv ids: {len(csv_ids)} | "
          f"union: {len(all_ids)}")

    have, pulled, missing = 0, 0, []
    for vid in sorted(all_ids):
        if (VIDEOS / f"{vid}.mp4").exists():
            have += 1
            continue
        if f"{vid}.mp4" in bucket_files:        # downloadable from Supabase
            if download_video(sb, f"{vid}.mp4"):
                pulled += 1
        else:
            missing.append(vid)                 # in CSV but not in bucket either
    print(f"=== local: {have} already present, {pulled} pulled from Supabase ===")
    if missing:
        print(f"  ! {len(missing)} id(s) in CSV but not in bucket: {missing}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
