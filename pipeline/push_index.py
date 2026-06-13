#!/usr/bin/env python3
"""Publish the frame index to Supabase so it's durable + portable, not just a
local scratch cache. Uploads to the knicks-clips bucket under index/:

  index/manifest.json           the per-video frame map
  index/signatures.bin          all frame signatures (16x16x3 per frame)
  index/cache/<hash>.<fps>fps.sigbin + .json   per-video signature cache

The per-video cache is the important part: 01-index-frames.py reuses a video's
sigbin (keyed by content hash + fps) instead of re-decoding. Mirroring it to
Supabase means a fresh machine can pull it and skip the heavy ffmpeg decode.

  python push_index.py
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import supabase_push

INDEX = Path(__file__).resolve().parent / "data" / "index"


def main() -> int:
    sb = supabase_push.client()
    if not sb.enabled:
        print("Supabase not configured"); return 1
    if not (INDEX / "manifest.json").exists():
        print("no index — run 01-index-frames.py first"); return 1

    sb.upload("index/manifest.json", (INDEX / "manifest.json").read_bytes(), "application/json")
    sb.upload("index/signatures.bin", (INDEX / "signatures.bin").read_bytes(),
              "application/octet-stream")
    sz = (INDEX / "signatures.bin").stat().st_size / 1e6
    print(f"uploaded manifest.json + signatures.bin ({sz:.0f} MB)")

    cache = sorted((INDEX / "videos").glob("*"))
    def up(p: Path):
        ct = "application/json" if p.suffix == ".json" else "application/octet-stream"
        return sb.upload(f"index/cache/{p.name}", p.read_bytes(), ct)
    ok = 0
    with ThreadPoolExecutor(max_workers=8) as pool:
        for r in pool.map(up, cache):
            ok += bool(r)
    print(f"uploaded {ok}/{len(cache)} per-video cache files to index/cache/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
