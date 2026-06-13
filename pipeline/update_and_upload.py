#!/usr/bin/env python3
"""Reconcile youtube_videos.csv with the local videos/ folder and Supabase:
- every local mp4 gets a CSV row (scrape its YouTube title + URL if new)
- upload to Supabase videos/ any video not already in the bucket
- re-upload the refreshed youtube_videos.csv / .json

  python update_and_upload.py
"""
from __future__ import annotations

import csv
import json
import subprocess
from pathlib import Path

import supabase_push

ROOT = Path(__file__).resolve().parent
VIDEOS = ROOT / "videos"
CSV = ROOT / "youtube_videos.csv"
FIELDS = ["video_id", "title", "url", "source_query", "clips_count"]


def scrape_title(vid: str) -> str:
    r = subprocess.run(["yt-dlp", "--skip-download", "--no-warnings", "--print",
                        "%(title)s", f"https://youtu.be/{vid}"],
                       capture_output=True, text=True)
    out = r.stdout.strip().splitlines()
    return out[0] if r.returncode == 0 and out else vid


def main() -> int:
    sb = supabase_push.client()
    if not sb.enabled:
        print("Supabase not configured"); return 1

    rows = {}
    if CSV.exists():
        for row in csv.DictReader(CSV.open()):
            rows[row["video_id"]] = row

    # what's already in the bucket
    bucket = set()
    off = 0
    while True:
        r = sb._sess.post(f"{sb.url}/storage/v1/object/list/{supabase_push.BUCKET}",
                          json={"prefix": "videos", "limit": 1000, "offset": off}, timeout=30)
        page = r.json() if r.status_code == 200 else []
        if not page:
            break
        bucket |= {x["name"] for x in page if x.get("name", "").endswith(".mp4")}
        if len(page) < 1000:
            break
        off += 1000

    for p in sorted(VIDEOS.glob("*.mp4")):
        vid = p.stem
        if vid not in rows:
            title = scrape_title(vid)
            rows[vid] = {"video_id": vid, "title": title,
                         "url": f"https://www.youtube.com/watch?v={vid}",
                         "source_query": "manual", "clips_count": 0}
            print(f"  + CSV row {vid}: {title[:50]}")
        if f"{vid}.mp4" not in bucket:
            url = f"{sb.url}/storage/v1/object/{supabase_push.BUCKET}/videos/{p.name}"
            with p.open("rb") as f:
                resp = sb._sess.post(url, data=f, headers={
                    "Content-Type": "video/mp4", "x-upsert": "true"}, timeout=3600)
            print(f"  {'↑ uploaded' if resp.status_code in (200,201) else '✗ '+str(resp.status_code)} "
                  f"{p.name} ({p.stat().st_size/1e6:.0f} MB)")

    with CSV.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=FIELDS)
        w.writeheader()
        for v in rows.values():
            w.writerow({k: v.get(k, "") for k in FIELDS})
    sb.upload("youtube_videos.csv", CSV.read_bytes(), "text/csv")
    sb.upload("youtube_videos.json", json.dumps(list(rows.values())).encode(), "application/json")
    print(f"CSV now {len(rows)} videos; re-uploaded to bucket")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
