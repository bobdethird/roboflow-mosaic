#!/usr/bin/env python3
"""Copy the videos from a source folder into pipeline/videos/ with Supabase-safe
names (the originals have spaces/unicode that break object URLs), and add CSV
rows (title from the filename, YouTube URL when an [11-char id] is present).

  python ingest_forty.py /Users/mohulshukla/Desktop/forty
"""
from __future__ import annotations

import csv
import hashlib
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VIDEOS = ROOT / "videos"
CSV = ROOT / "youtube_videos.csv"
FIELDS = ["video_id", "title", "url", "source_query", "clips_count"]
EXTS = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}


def slug(s: str) -> str:
    s = re.sub(r"\[[^\]]*\]", "", s)                 # drop [id] tags
    s = re.sub(r"[^A-Za-z0-9]+", "-", s.lower()).strip("-")
    return s[:40] or "clip"


def main() -> int:
    src = Path(sys.argv[1] if len(sys.argv) > 1 else "/Users/mohulshukla/Desktop/forty")
    if not src.exists():
        print(f"source not found: {src}"); return 1
    VIDEOS.mkdir(parents=True, exist_ok=True)

    rows = {}
    if CSV.exists():
        for row in csv.DictReader(CSV.open()):
            rows[row["video_id"]] = row

    files = sorted(p for p in src.iterdir() if p.suffix.lower() in EXTS)
    print(f"{len(files)} source videos in {src.name}")
    added = 0
    for f in files:
        h = hashlib.sha1(f.name.encode()).hexdigest()[:8]
        vid = f"{slug(f.stem)}-{h}"
        dst = VIDEOS / f"{vid}.mp4"
        if not dst.exists():
            shutil.copy2(f, dst)
            added += 1
        m = re.search(r"\[([A-Za-z0-9_-]{11})\]", f.name)
        url = f"https://www.youtube.com/watch?v={m.group(1)}" if m else ""
        title = re.sub(r"\s*\[[^\]]*\]\s*", " ", f.stem).strip() or f.stem
        rows[vid] = {"video_id": vid, "title": title, "url": url,
                     "source_query": "forty", "clips_count": 0}

    with CSV.open("w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=FIELDS)
        w.writeheader()
        for v in rows.values():
            w.writerow({k: v.get(k, "") for k in FIELDS})
    print(f"copied {added} new file(s); CSV now {len(rows)} videos")
    print(f"local videos total: {len(list(VIDEOS.glob('*.mp4')))}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
