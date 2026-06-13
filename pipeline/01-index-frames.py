#!/usr/bin/env python3
"""Build a persistent 16x16 RGB frame-signature index for pipeline/videos."""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


SIG_GRID = 16
SIG_CHANNELS = 3
SIG_BYTES = SIG_GRID * SIG_GRID * SIG_CHANNELS
SCHEMA_VERSION = 1

PIPELINE_ROOT = Path(__file__).resolve().parent
VIDEOS_DIR = PIPELINE_ROOT / "videos"
INDEX_DIR = PIPELINE_ROOT / "data" / "index"
CACHE_DIR = INDEX_DIR / "videos"
SIGNATURES_PATH = INDEX_DIR / "signatures.bin"
MANIFEST_PATH = INDEX_DIR / "manifest.json"


@dataclass(frozen=True)
class VideoFile:
    path: Path
    rel_path: str
    stem: str
    stat_size: int
    stat_mtime_ns: int
    content_hash: str


def sample_fps() -> float:
    raw = os.environ.get("MOSAIC_SAMPLE_FPS", "5")
    try:
        fps = float(raw)
    except ValueError as exc:
        raise SystemExit(f"MOSAIC_SAMPLE_FPS must be numeric, got {raw!r}") from exc
    if fps <= 0:
        raise SystemExit("MOSAIC_SAMPLE_FPS must be greater than zero")
    return fps


def run_json(command: list[str]) -> dict[str, Any]:
    result = subprocess.run(
        command,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return json.loads(result.stdout)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug[:80] or "video"


def cache_fps_token(fps: float) -> str:
    return f"{fps:.6f}".rstrip("0").rstrip(".").replace(".", "p")


def is_video_file(path: Path) -> bool:
    name = path.name
    if name.startswith("."):
        return False
    if ".part" in name or name.endswith(".ytdl"):
        return False
    return path.suffix.lower() in {".mp4", ".mov", ".m4v", ".webm", ".mkv"}


def list_videos() -> list[Path]:
    if not VIDEOS_DIR.exists():
        raise SystemExit(f"Video directory not found: {VIDEOS_DIR}")
    return sorted(path for path in VIDEOS_DIR.rglob("*") if path.is_file() and is_video_file(path))


def probe_video(path: Path) -> dict[str, Any]:
    info = run_json(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "format=duration:stream=width,height,duration",
            "-of",
            "json",
            str(path),
        ]
    )
    stream = (info.get("streams") or [{}])[0]
    duration = info.get("format", {}).get("duration") or stream.get("duration")
    return {
        "width": int(stream.get("width") or 0),
        "height": int(stream.get("height") or 0),
        "duration": float(duration) if duration is not None else None,
    }


def decode_signatures(video_path: Path, out_path: Path, fps: float) -> int:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = out_path.with_suffix(out_path.suffix + ".tmp")
    vf = ",".join(
        [
            f"fps={fps}",
            "scale=16:16:force_original_aspect_ratio=increase:flags=area",
            "crop=16:16",
            "format=rgb24",
        ]
    )
    command = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(video_path),
        "-vf",
        vf,
        "-f",
        "rawvideo",
        "-pix_fmt",
        "rgb24",
        str(tmp_path),
    ]
    subprocess.run(command, check=True)
    byte_count = tmp_path.stat().st_size
    if byte_count % SIG_BYTES:
        tmp_path.unlink(missing_ok=True)
        raise RuntimeError(
            f"Signature file for {video_path.name} has invalid size {byte_count}"
        )
    tmp_path.replace(out_path)
    return byte_count // SIG_BYTES


def normalized_title(path: Path) -> str:
    name = path.stem.lower()
    name = re.sub(r"\[[^\]]*(downloaded|combined|fhls|frag|mp4|part)[^\]]*\]", " ", name)
    name = re.sub(r"\[(downloaded|combined)-?\d*\]", " ", name)
    name = re.sub(r"\b(downloaded|combined|fhls|frag)\b[-_\d]*", " ", name)
    name = re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", name)).strip()
    return name


def duplicate_report(video_files: list[VideoFile]) -> dict[str, Any]:
    by_hash: dict[str, list[VideoFile]] = {}
    by_title: dict[str, list[VideoFile]] = {}
    for video in video_files:
        by_hash.setdefault(video.content_hash, []).append(video)
        key = normalized_title(video.path)
        if len(key) >= 12:
            by_title.setdefault(key, []).append(video)

    exact = [
        {
            "contentHash": content_hash,
            "kept": group[0].rel_path,
            "duplicates": [item.rel_path for item in group[1:]],
        }
        for content_hash, group in by_hash.items()
        if len(group) > 1
    ]
    possible = [
        {
            "normalizedTitle": key,
            "files": [item.rel_path for item in group],
        }
        for key, group in by_title.items()
        if len(group) > 1
    ]
    return {
        "exactDuplicates": exact,
        "possibleDuplicateGroups": possible,
    }


def load_previous_manifest() -> dict[str, Any]:
    if not MANIFEST_PATH.exists():
        return {}
    return json.loads(MANIFEST_PATH.read_text())


def build_video_files(paths: list[Path], previous: dict[str, Any]) -> list[VideoFile]:
    previous_by_rel = {
        item.get("path"): item
        for item in previous.get("allVideos", previous.get("videos", []))
        if item.get("path")
    }
    out: list[VideoFile] = []
    for index, path in enumerate(paths, start=1):
        stat = path.stat()
        rel_path = path.relative_to(PIPELINE_ROOT).as_posix()
        cached = previous_by_rel.get(rel_path)
        if (
            cached
            and cached.get("statSize") == stat.st_size
            and cached.get("statMtimeNs") == stat.st_mtime_ns
            and cached.get("contentHash")
        ):
            content_hash = cached["contentHash"]
        else:
            content_hash = file_sha256(path)
        out.append(
            VideoFile(
                path=path,
                rel_path=rel_path,
                stem=path.stem,
                stat_size=stat.st_size,
                stat_mtime_ns=stat.st_mtime_ns,
                content_hash=content_hash,
            )
        )
        print(f"[hash {index}/{len(paths)}] {rel_path}")
    return out


def main() -> int:
    fps = sample_fps()
    paths = list_videos()
    if not paths:
        raise SystemExit(f"No supported videos found in {VIDEOS_DIR}")

    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    previous = load_previous_manifest()
    video_files = build_video_files(paths, previous)
    duplicates = duplicate_report(video_files)

    seen_hashes: set[str] = set()
    included: list[VideoFile] = []
    skipped_exact: list[dict[str, str]] = []
    for video in video_files:
        if video.content_hash in seen_hashes:
            skipped_exact.append(
                {"path": video.rel_path, "contentHash": video.content_hash}
            )
            continue
        seen_hashes.add(video.content_hash)
        included.append(video)

    combined_tmp = SIGNATURES_PATH.with_suffix(".bin.tmp")
    frame_offset = 0
    videos_manifest: list[dict[str, Any]] = []
    fps_token = cache_fps_token(fps)
    with combined_tmp.open("wb") as combined:
        for index, video in enumerate(included, start=1):
            video_id = f"{slugify(video.stem)}-{video.content_hash[:8]}"
            sig_path = CACHE_DIR / f"{video.content_hash}.{fps_token}fps.sigbin"
            meta_path = CACHE_DIR / f"{video.content_hash}.{fps_token}fps.json"
            meta = json.loads(meta_path.read_text()) if meta_path.exists() else None
            if sig_path.exists() and meta and meta.get("sampleFps") == fps:
                frame_count = int(meta["frameCount"])
                probe = meta["probe"]
                print(f"[reuse {index}/{len(included)}] {video.rel_path} ({frame_count} frames)")
            else:
                probe = probe_video(video.path)
                print(f"[decode {index}/{len(included)}] {video.rel_path}")
                frame_count = decode_signatures(video.path, sig_path, fps)
                meta_path.write_text(
                    json.dumps(
                        {
                            "contentHash": video.content_hash,
                            "sampleFps": fps,
                            "sigGrid": SIG_GRID,
                            "sigBytes": SIG_BYTES,
                            "frameCount": frame_count,
                            "probe": probe,
                            "generatedAt": time.strftime(
                                "%Y-%m-%dT%H:%M:%SZ", time.gmtime()
                            ),
                        },
                        indent=2,
                    )
                    + "\n"
                )

            with sig_path.open("rb") as handle:
                shutil.copyfileobj(handle, combined)

            videos_manifest.append(
                {
                    "videoId": video_id,
                    "path": video.rel_path,
                    "originalName": video.path.name,
                    "contentHash": video.content_hash,
                    "statSize": video.stat_size,
                    "statMtimeNs": video.stat_mtime_ns,
                    "duration": probe.get("duration"),
                    "width": probe.get("width"),
                    "height": probe.get("height"),
                    "sampleFps": fps,
                    "frameOffset": frame_offset,
                    "frameCount": frame_count,
                }
            )
            frame_offset += frame_count

    combined_tmp.replace(SIGNATURES_PATH)
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sourceDir": VIDEOS_DIR.relative_to(PIPELINE_ROOT).as_posix(),
        "sampleFps": fps,
        "sigGrid": SIG_GRID,
        "sigBytes": SIG_BYTES,
        "frameCount": frame_offset,
        "signaturesPath": SIGNATURES_PATH.relative_to(PIPELINE_ROOT).as_posix(),
        "videos": videos_manifest,
        "allVideos": [
            {
                "path": video.rel_path,
                "contentHash": video.content_hash,
                "statSize": video.stat_size,
                "statMtimeNs": video.stat_mtime_ns,
            }
            for video in video_files
        ],
        "skippedExactDuplicates": skipped_exact,
        "duplicateReport": duplicates,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n")
    print(
        f"Wrote {frame_offset} signatures from {len(videos_manifest)} videos "
        f"to {SIGNATURES_PATH.relative_to(PIPELINE_ROOT)}"
    )
    if duplicates["exactDuplicates"] or duplicates["possibleDuplicateGroups"]:
        print(
            "Duplicate report: "
            f"{len(duplicates['exactDuplicates'])} exact, "
            f"{len(duplicates['possibleDuplicateGroups'])} possible groups"
        )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print(exc, file=sys.stderr)
        if exc.stderr:
            print(exc.stderr, file=sys.stderr)
        raise SystemExit(exc.returncode)
