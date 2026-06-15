#!/usr/bin/env python3
"""One-shot: publish the clips already in clips.json to Supabase.

- backfills color_rgb into clips.json (derived from the stored hex)
- writes youtube_videos.csv (one row per source video)
- uploads each clip mp4 + end frame to the knicks-clips storage bucket
- uploads a clips manifest + youtube_videos.csv/json to the bucket (queryable
  even before the SQL tables exist)
- upserts youtube_videos + clips rows (no-ops with a message if tables missing)

  python push_existing.py
"""
from __future__ import annotations

import csv
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import supabase_push

SCRIPT_DIR = Path(__file__).resolve().parent
CLIPS_JSON = SCRIPT_DIR / "clips.json"
VIDEOS_CSV = SCRIPT_DIR / "youtube_videos.csv"


def hex_to_rgb(h: str) -> list[int]:
    h = h.lstrip("#")
    return [int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)]


def main() -> int:
    manifest = json.loads(CLIPS_JSON.read_text())
    clips = manifest["clips"]
    print(f"{len(clips)} clips in manifest")

    # 1) backfill rgb
    changed = False
    for c in clips:
        if "color_rgb" not in c and c.get("color_hex"):
            c["color_rgb"] = hex_to_rgb(c["color_hex"])
            changed = True
    if changed:
        CLIPS_JSON.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
        print("  backfilled color_rgb into clips.json")

    # 2) youtube_videos rows (dedup by source video)
    videos: dict[str, dict] = {}
    for c in clips:
        vid = c["source_video"]
        v = videos.setdefault(vid, {"video_id": vid, "title": c.get("title", ""),
                                    "url": c["url"], "source_query": "initial",
                                    "clips_count": 0})
        v["clips_count"] += 1
    with VIDEOS_CSV.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["video_id", "title", "url",
                                          "source_query", "clips_count"])
        w.writeheader()
        for v in videos.values():
            w.writerow(v)
    print(f"  wrote {VIDEOS_CSV.name} ({len(videos)} videos)")

    sb = supabase_push.client()
    if not sb.enabled:
        print("  Supabase not configured — wrote local CSV only.")
        return 0
    sb.ensure_bucket()

    # 3) upload mp4 + frame per clip (parallel)
    def upload_clip(c):
        cid = c["clip_id"]
        ok_f = sb.upload_file(f"frames/{cid}.jpg", SCRIPT_DIR / c["frame_file"], "image/jpeg")
        ok_c = sb.upload_file(f"clips/{cid}.mp4", SCRIPT_DIR / c["clip_file"], "video/mp4")
        return ok_f and ok_c

    done = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        for ok in pool.map(upload_clip, clips):
            done += 1
            if done % 10 == 0 or done == len(clips):
                print(f"  uploaded {done}/{len(clips)} clip+frame pairs", end="\r")
    print()

    # 4) queryable artifacts in the bucket (work without SQL tables)
    sb.upload("clips.json", json.dumps(manifest, ensure_ascii=False).encode(),
              "application/json")
    sb.upload("youtube_videos.json", json.dumps(list(videos.values())).encode(),
              "application/json")
    sb.upload("youtube_videos.csv", VIDEOS_CSV.read_bytes(), "text/csv")
    print("  uploaded clips.json + youtube_videos.{json,csv} to bucket")

    # 5) table rows (no-op + message if tables not created yet)
    sb.upsert("youtube_videos", list(videos.values()), on_conflict="video_id")
    rows = []
    for c in clips:
        r, g, b = c.get("color_rgb") or hex_to_rgb(c["color_hex"])
        L, A, B = c["color_lab"]
        rows.append({"clip_id": c["clip_id"], "source_video": c["source_video"],
                     "url": c["url"], "title": c.get("title", ""),
                     "end_seconds": c["end_seconds"], "end_timestamp": c["end_timestamp"],
                     "clip_start": c["clip_start"], "duration": c["duration"],
                     "color_hex": c["color_hex"], "r": r, "g": g, "b": b,
                     "lab_l": round(L, 2), "lab_a": round(A, 2), "lab_b": round(B, 2),
                     "clip_path": f"clips/{c['clip_id']}.mp4",
                     "frame_path": f"frames/{c['clip_id']}.jpg"})
    sb.upsert("clips", rows, on_conflict="clip_id")
    print("✓ done")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
