#!/usr/bin/env python3
"""Stream the full source mp4s in pipeline/videos/ to the Supabase bucket under
the videos/ prefix (same bucket as clips/ and frames/). Large files are streamed
(not read into memory) and uploaded in parallel.

  python upload_videos.py
"""
from __future__ import annotations

import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import supabase_push

VIDEOS = Path(__file__).resolve().parent / "videos"
_print_lock = threading.Lock()


def upload_one(sb, path: Path) -> tuple[str, bool, str]:
    obj = f"videos/{path.name}"
    url = f"{sb.url}/storage/v1/object/{supabase_push.BUCKET}/{obj}"
    headers = {"Content-Type": "video/mp4", "x-upsert": "true",
               "cache-control": "31536000"}
    try:
        with path.open("rb") as f:                       # stream, don't buffer
            r = sb._sess.post(url, data=f, headers=headers, timeout=3600)
    except Exception as e:  # noqa: BLE001
        return path.name, False, str(e)[:120]
    return path.name, r.status_code in (200, 201), f"{r.status_code} {r.text[:80]}"


def main() -> int:
    sb = supabase_push.client()
    if not sb.enabled:
        print("Supabase not configured")
        return 1
    # Raise the bucket cap (honors the dashboard limit; no-op if already high).
    sb._sess.put(f"{sb.url}/storage/v1/bucket/{supabase_push.BUCKET}",
                 json={"id": supabase_push.BUCKET, "file_size_limit": 53687091200,
                       "public": False}, timeout=20)

    vids = sorted(VIDEOS.glob("*.mp4"))
    total_gb = sum(p.stat().st_size for p in vids) / 1e9
    print(f"uploading {len(vids)} videos ({total_gb:.1f} GB) to "
          f"{supabase_push.BUCKET}/videos/")
    ok = 0
    with ThreadPoolExecutor(max_workers=3) as pool:
        futs = [pool.submit(upload_one, sb, p) for p in vids]
        for f in futs:
            name, good, info = f.result()
            with _print_lock:
                if good:
                    ok += 1
                    print(f"  ✓ {name}")
                else:
                    print(f"  ✗ {name}: {info}")
    print(f"=== {ok}/{len(vids)} videos uploaded ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
