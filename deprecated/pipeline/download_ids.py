#!/usr/bin/env python3
"""Sequentially download YouTube videos/IDs into pipeline/videos/ (gentle on the
bot wall: one at a time, cookies + tv_embedded client, retries). Then run
`python diversity.py --local` to color-mine + upload them.

  python download_ids.py <id-or-url> [<id-or-url> ...]
"""
import subprocess, sys, time
from pathlib import Path

VIDEOS = Path(__file__).resolve().parent / "videos"
VIDEOS.mkdir(exist_ok=True)


def ytid(s: str) -> str:
    import re
    m = re.search(r"(?:v=|youtu\.be/|/)([A-Za-z0-9_-]{11})", s)
    return m.group(1) if m else s


def download(vid: str) -> bool:
    out = VIDEOS / f"{vid}.mp4"
    if out.exists():
        print(f"  have {vid}")
        return True
    cmd = ["yt-dlp", "-f", "bv*+ba/b", "--merge-output-format", "mp4",
           "-o", str(VIDEOS / "%(id)s.%(ext)s"), "--no-progress", "--no-warnings",
           "--extractor-args", "youtube:player_client=tv_embedded,web_safari,default",
           "--cookies-from-browser", "chrome",
           "--print", "after_move:DL %(id)s | %(title).55s", f"https://youtu.be/{vid}"]
    for attempt in range(5):
        r = subprocess.run(cmd, capture_output=True, text=True)
        for ln in r.stdout.splitlines():
            if ln.startswith("DL "):
                print(f"  ✓ {ln[3:]}")
        if out.exists():
            return True
        time.sleep(4)
    print(f"  ✗ FAILED {vid}: {(r.stderr or '').strip()[-120:]}")
    return False


def main() -> int:
    ids = [ytid(a) for a in sys.argv[1:]]
    if not ids:
        print("usage: python download_ids.py <id-or-url> ...")
        return 1
    ok = 0
    for i, vid in enumerate(ids, 1):
        print(f"[{i}/{len(ids)}] {vid}")
        if download(vid):
            ok += 1
        time.sleep(4)
    print(f"=== {ok}/{len(ids)} downloaded ===")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
