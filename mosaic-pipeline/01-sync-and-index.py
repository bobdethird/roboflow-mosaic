#!/usr/bin/env python3
"""Step 1: sync source videos and build the frame-signature index.

This is the fresh pipeline entrypoint for the mosaic project. It makes
`source-videos/` the local source of truth by:

1. Importing videos that already exist locally, using hard links by default.
2. Downloading missing videos from the Supabase Storage bucket.
3. Building a persistent 16x16 RGB frame-signature index over unique videos.

The index is frame-number based: later render steps should reproduce the same
`fps=<sample_fps>` stream and select by frame number, not by timestamp seeking.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import quote

import requests

try:
    from dotenv import load_dotenv as _load_dotenv
except ModuleNotFoundError:
    _load_dotenv = None


SIG_GRID = 16
SIG_CHANNELS = 3
SIG_BYTES = SIG_GRID * SIG_GRID * SIG_CHANNELS
SCHEMA_VERSION = 1
DEFAULT_SAMPLE_FPS = 5.0
VIDEO_SUFFIXES = {".mp4", ".mov", ".m4v", ".webm", ".mkv"}

PIPELINE_ROOT = Path(__file__).resolve().parent
REPO_ROOT = PIPELINE_ROOT.parent
DEFAULT_VIDEOS_DIR = REPO_ROOT / "source-videos"
DATA_DIR = PIPELINE_ROOT / "data"
INDEX_DIR = DATA_DIR / "index"
CACHE_DIR = INDEX_DIR / "cache"
SIGNATURES_PATH = INDEX_DIR / "signatures.bin"
MANIFEST_PATH = INDEX_DIR / "manifest.json"
SYNC_REPORT_PATH = DATA_DIR / "step1-sync-report.json"


@dataclass(frozen=True)
class VideoFile:
    path: Path
    rel_path: str
    stat_size: int
    stat_mtime_ns: int
    content_hash: str


@dataclass(frozen=True)
class RemoteObject:
    object_path: str
    name: str
    size: int | None


@dataclass(frozen=True)
class PreparedSignature:
    video: VideoFile
    sig_path: Path
    frame_count: int
    probe: dict[str, Any]
    action: str
    elapsed_sec: float


def utc_now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def load_environment() -> None:
    for env_path in (REPO_ROOT / ".env", REPO_ROOT / ".env.local"):
        if _load_dotenv is not None:
            _load_dotenv(env_path)
            continue
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


def env_list(name: str) -> list[str]:
    raw = os.environ.get(name, "")
    if not raw.strip():
        return []
    return [item.strip() for item in raw.split(os.pathsep) if item.strip()]


def env_int(name: str, fallback: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw == "":
        return fallback
    try:
        value = int(raw)
    except ValueError:
        return fallback
    return max(1, value)


def default_worker_count() -> int:
    return max(1, min(8, (os.cpu_count() or 4) // 2 or 1))


def resolve_repo_path(value: str | Path) -> Path:
    path = Path(value).expanduser()
    return path if path.is_absolute() else REPO_ROOT / path


def rel_to_pipeline(path: Path) -> str:
    return os.path.relpath(path, PIPELINE_ROOT).replace(os.sep, "/")


def is_video_file(path: Path) -> bool:
    name = path.name
    if name.startswith("."):
        return False
    if ".part" in name or name.endswith(".ytdl"):
        return False
    return path.suffix.lower() in VIDEO_SUFFIXES


def list_videos(root: Path) -> list[Path]:
    if not root.exists():
        return []
    return sorted(path for path in root.rglob("*") if path.is_file() and is_video_file(path))


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def hash_paths(paths: list[Path], workers: int, label: str) -> dict[Path, str]:
    """Hash files concurrently while keeping progress deterministic enough to read."""
    if not paths:
        return {}
    out: dict[Path, str] = {}
    with ThreadPoolExecutor(max_workers=max(1, workers)) as pool:
        futures = {pool.submit(file_sha256, path): path for path in paths}
        for done, future in enumerate(as_completed(futures), start=1):
            path = futures[future]
            out[path] = future.result()
            print(f"[{label} {done}/{len(paths)}] {path.name}", flush=True)
    return out


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug[:96] or "video"


def cache_fps_token(fps: float) -> str:
    return f"{fps:.6f}".rstrip("0").rstrip(".").replace(".", "p")


def parse_sample_fps(cli_value: float | None) -> float:
    raw = cli_value if cli_value is not None else os.environ.get("MOSAIC_SAMPLE_FPS", DEFAULT_SAMPLE_FPS)
    try:
        fps = float(raw)
    except (TypeError, ValueError) as exc:
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
        "-y",
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
        raise RuntimeError(f"Signature file for {video_path.name} has invalid size {byte_count}")
    tmp_path.replace(out_path)
    return byte_count // SIG_BYTES


def valid_signature_cache(sig_path: Path, meta_path: Path, fps: float) -> tuple[int, dict[str, Any]] | None:
    if not sig_path.exists() or not meta_path.exists():
        return None
    try:
        meta = json.loads(meta_path.read_text())
        frame_count = int(meta["frameCount"])
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None
    if float(meta.get("sampleFps", -1)) != fps:
        return None
    try:
        if sig_path.stat().st_size != frame_count * SIG_BYTES:
            return None
    except OSError:
        return None
    return frame_count, dict(meta.get("probe") or {})


def default_cache_sources(args: argparse.Namespace) -> list[Path]:
    raw = [resolve_repo_path(item) for item in args.cache_source]
    raw += [resolve_repo_path(item) for item in env_list("MOSAIC_CACHE_SOURCES")]
    if not raw:
        raw = [
            REPO_ROOT / "pipeline" / "data" / "index" / "videos",
            REPO_ROOT / "pipeline" / "data" / "index" / "cache",
            REPO_ROOT / "video-generation" / "data" / "index" / "videos",
            REPO_ROOT / "video-generation" / "data" / "index" / "cache",
        ]
    out: list[Path] = []
    seen: set[Path] = set()
    for source in raw:
        try:
            key = source.resolve()
        except OSError:
            key = source
        if key == CACHE_DIR.resolve() or key in seen:
            continue
        seen.add(key)
        out.append(source)
    return out


def import_signature_cache(
    content_hash: str,
    fps_token: str,
    fps: float,
    cache_sources: list[Path],
    dst_sig: Path,
    dst_meta: Path,
) -> tuple[int, dict[str, Any]] | None:
    name = f"{content_hash}.{fps_token}fps"
    for source in cache_sources:
        src_sig = source / f"{name}.sigbin"
        src_meta = source / f"{name}.json"
        valid = valid_signature_cache(src_sig, src_meta, fps)
        if valid is None:
            continue
        dst_sig.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src_sig, dst_sig)
        shutil.copy2(src_meta, dst_meta)
        return valid
    return None


def write_signature_meta(meta_path: Path, video: VideoFile, fps: float, frame_count: int, probe: dict[str, Any]) -> None:
    meta_path.write_text(
        json.dumps(
            {
                "contentHash": video.content_hash,
                "sampleFps": fps,
                "sigGrid": SIG_GRID,
                "sigBytes": SIG_BYTES,
                "frameCount": frame_count,
                "probe": probe,
                "generatedAt": utc_now(),
            },
            indent=2,
        )
        + "\n"
    )


def prepare_signature(
    video: VideoFile,
    fps: float,
    fps_token: str,
    cache_sources: list[Path],
) -> PreparedSignature:
    started_at = time.time()
    sig_path = CACHE_DIR / f"{video.content_hash}.{fps_token}fps.sigbin"
    meta_path = CACHE_DIR / f"{video.content_hash}.{fps_token}fps.json"
    valid = valid_signature_cache(sig_path, meta_path, fps)
    if valid is not None:
        frame_count, probe = valid
        return PreparedSignature(video, sig_path, frame_count, probe, "reuse", time.time() - started_at)

    imported = import_signature_cache(
        video.content_hash,
        fps_token,
        fps,
        cache_sources,
        sig_path,
        meta_path,
    )
    if imported is not None:
        frame_count, probe = imported
        return PreparedSignature(video, sig_path, frame_count, probe, "import-cache", time.time() - started_at)

    probe = probe_video(video.path)
    frame_count = decode_signatures(video.path, sig_path, fps)
    write_signature_meta(meta_path, video, fps, frame_count, probe)
    return PreparedSignature(video, sig_path, frame_count, probe, "decode", time.time() - started_at)


def load_previous_manifest() -> dict[str, Any]:
    if not MANIFEST_PATH.exists():
        return {}
    return json.loads(MANIFEST_PATH.read_text())


def build_video_files(paths: list[Path], previous: dict[str, Any], workers: int) -> list[VideoFile]:
    previous_by_rel = {
        item.get("path"): item
        for item in previous.get("allVideos", previous.get("videos", []))
        if item.get("path")
    }
    stats: dict[Path, os.stat_result] = {}
    cached_hashes: dict[Path, str] = {}
    to_hash: list[Path] = []
    for path in paths:
        stat = path.stat()
        rel_path = rel_to_pipeline(path)
        cached = previous_by_rel.get(rel_path)
        stats[path] = stat
        if (
            cached
            and cached.get("statSize") == stat.st_size
            and cached.get("statMtimeNs") == stat.st_mtime_ns
            and cached.get("contentHash")
        ):
            cached_hashes[path] = str(cached["contentHash"])
        else:
            to_hash.append(path)
    hashed = hash_paths(to_hash, workers, "hash")
    out: list[VideoFile] = []
    for index, path in enumerate(paths, start=1):
        stat = stats[path]
        rel_path = rel_to_pipeline(path)
        content_hash = cached_hashes.get(path) or hashed[path]
        out.append(
            VideoFile(
                path=path,
                rel_path=rel_path,
                stat_size=stat.st_size,
                stat_mtime_ns=stat.st_mtime_ns,
                content_hash=content_hash,
            )
        )
        print(f"[manifest {index}/{len(paths)}] {rel_path}", flush=True)
    return out


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
    return {
        "exactDuplicates": [
            {
                "contentHash": content_hash,
                "kept": group[0].rel_path,
                "duplicates": [item.rel_path for item in group[1:]],
            }
            for content_hash, group in by_hash.items()
            if len(group) > 1
        ],
        "possibleDuplicateGroups": [
            {"normalizedTitle": key, "files": [item.rel_path for item in group]}
            for key, group in by_title.items()
            if len(group) > 1
        ],
    }


def unique_destination(videos_dir: Path, name: str, existing_names: set[str], content_hash: str) -> Path:
    candidate = videos_dir / name
    if name not in existing_names:
        existing_names.add(name)
        return candidate
    stem = Path(name).stem
    suffix = Path(name).suffix
    candidate_name = f"{stem}-{content_hash[:8]}{suffix}"
    counter = 2
    while candidate_name in existing_names:
        candidate_name = f"{stem}-{content_hash[:8]}-{counter}{suffix}"
        counter += 1
    existing_names.add(candidate_name)
    return videos_dir / candidate_name


def materialize_video(src: Path, dst: Path, mode: str) -> str:
    dst.parent.mkdir(parents=True, exist_ok=True)
    if src.resolve() == dst.resolve():
        return "already-local"
    if mode == "symlink":
        os.symlink(src, dst)
        return "symlinked"
    if mode == "copy":
        shutil.copy2(src, dst)
        return "copied"
    try:
        os.link(src, dst)
        return "hardlinked"
    except OSError:
        shutil.copy2(src, dst)
        return "copied"


def default_local_sources(args: argparse.Namespace) -> list[Path]:
    raw = [resolve_repo_path(item) for item in args.local_source]
    raw += [resolve_repo_path(item) for item in env_list("MOSAIC_LOCAL_VIDEO_DIRS")]
    if not raw:
        raw = [REPO_ROOT / "pipeline" / "videos"]
    sources: list[Path] = []
    seen: set[Path] = set()
    for source in raw:
        resolved = source if source.is_absolute() else (REPO_ROOT / source)
        try:
            key = resolved.resolve()
        except OSError:
            key = resolved
        if key == args.videos_dir.resolve() or key in seen:
            continue
        seen.add(key)
        sources.append(resolved)
    return sources


def import_local_videos(args: argparse.Namespace) -> dict[str, Any]:
    if args.skip_local_import or args.index_only:
        return {"skipped": True, "sources": [], "imported": [], "duplicates": []}
    args.videos_dir.mkdir(parents=True, exist_ok=True)
    existing_paths = list_videos(args.videos_dir)
    existing_names = {path.name for path in existing_paths}
    known_hashes = set(hash_paths(existing_paths, args.hash_workers, "hash-existing").values())
    imported: list[dict[str, Any]] = []
    duplicates: list[dict[str, Any]] = []
    sources = default_local_sources(args)
    candidates: list[Path] = []
    for source in sources:
        found = list_videos(source)
        print(f"[local] {source}: {len(found)} supported video(s)", flush=True)
        candidates.extend(found)
    candidate_hashes = hash_paths(candidates, args.hash_workers, "hash-local")
    for index, src in enumerate(candidates, start=1):
        content_hash = candidate_hashes[src]
        if content_hash in known_hashes:
            duplicates.append({"source": str(src), "contentHash": content_hash})
            continue
        dst = unique_destination(args.videos_dir, src.name, existing_names, content_hash)
        action = "would-import" if args.dry_run else materialize_video(src, dst, args.import_mode)
        known_hashes.add(content_hash)
        imported.append(
            {
                "source": str(src),
                "destination": rel_to_pipeline(dst),
                "contentHash": content_hash,
                "action": action,
            }
        )
        print(f"[local {index}/{len(candidates)}] {action} {src.name}", flush=True)
    return {
        "skipped": False,
        "sources": [str(source) for source in sources],
        "imported": imported,
        "duplicates": duplicates,
    }


class SupabaseStorage:
    def __init__(self, bucket: str):
        self.url = (os.environ.get("NEXT_PUBLIC_SUPABASE_URL") or "").rstrip("/")
        self.key = (
            os.environ.get("SUPABASE_SECRET_KEY")
            or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
            or ""
        ).strip()
        self.bucket = bucket
        self.enabled = bool(self.url and self.key)
        self.session = requests.Session()
        self.session.headers.update({"apikey": self.key, "Authorization": f"Bearer {self.key}"})

    def list_objects(self, prefix: str) -> list[RemoteObject]:
        objects: list[RemoteObject] = []
        offset = 0
        while True:
            response = self.session.post(
                f"{self.url}/storage/v1/object/list/{self.bucket}",
                json={"prefix": prefix.strip("/"), "limit": 1000, "offset": offset},
                timeout=30,
            )
            if response.status_code != 200:
                raise RuntimeError(
                    f"Supabase list failed: {response.status_code} {response.text[:240]}"
                )
            page = response.json()
            if not page:
                break
            for item in page:
                name = item.get("name") or ""
                if not name or name.endswith("/"):
                    continue
                object_path = name if name.startswith(f"{prefix}/") else f"{prefix.strip('/')}/{name}"
                if Path(object_path).suffix.lower() not in VIDEO_SUFFIXES:
                    continue
                metadata = item.get("metadata") or {}
                size = metadata.get("size") or metadata.get("contentLength")
                objects.append(RemoteObject(object_path=object_path, name=Path(object_path).name, size=size))
            if len(page) < 1000:
                break
            offset += 1000
        return objects

    def download(self, object_path: str, dst: Path) -> None:
        encoded = quote(object_path, safe="/")
        urls = [
            f"{self.url}/storage/v1/object/authenticated/{self.bucket}/{encoded}",
            f"{self.url}/storage/v1/object/{self.bucket}/{encoded}",
        ]
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_suffix(dst.suffix + ".part")
        last_error = ""
        for url in urls:
            with self.session.get(url, stream=True, timeout=3600) as response:
                if response.status_code != 200:
                    last_error = f"{response.status_code} {response.text[:160]}"
                    continue
                with tmp.open("wb") as handle:
                    for chunk in response.iter_content(chunk_size=1024 * 1024):
                        if chunk:
                            handle.write(chunk)
                tmp.replace(dst)
                return
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"Supabase download failed for {object_path}: {last_error}")


def sync_supabase_videos(args: argparse.Namespace) -> dict[str, Any]:
    if args.skip_supabase or args.index_only:
        return {"skipped": True, "bucket": args.bucket, "prefix": args.prefix, "downloaded": []}
    storage = SupabaseStorage(args.bucket)
    if not storage.enabled:
        raise SystemExit(
            "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and "
            "SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY, or pass --skip-supabase."
        )
    remote_objects = storage.list_objects(args.prefix)
    existing_names = {path.name for path in list_videos(args.videos_dir)}
    planned: list[tuple[int, RemoteObject, Path]] = []
    skipped_existing: list[str] = []
    print(f"[supabase] {args.bucket}/{args.prefix}: {len(remote_objects)} video object(s)", flush=True)
    for index, obj in enumerate(remote_objects, start=1):
        if obj.name in existing_names:
            skipped_existing.append(obj.object_path)
            continue
        if args.max_downloads is not None and len(planned) >= args.max_downloads:
            break
        dst = args.videos_dir / obj.name
        existing_names.add(obj.name)
        planned.append((index, obj, dst))
    if args.dry_run:
        downloaded = [
            {
                "objectPath": obj.object_path,
                "destination": rel_to_pipeline(dst),
                "size": obj.size,
                "action": "would-download",
            }
            for _, obj, dst in planned
        ]
        for index, obj, _ in planned:
            print(f"[supabase {index}/{len(remote_objects)}] would-download {obj.object_path}", flush=True)
    else:
        downloaded: list[dict[str, Any]] = []

        def download_one(item: tuple[int, RemoteObject, Path]) -> dict[str, Any]:
            index, obj, dst = item
            # Keep one requests.Session per worker task; requests Sessions are not
            # a shared-thread primitive and downloads are long-lived streams.
            SupabaseStorage(args.bucket).download(obj.object_path, dst)
            return {
                "index": index,
                "objectPath": obj.object_path,
                "destination": rel_to_pipeline(dst),
                "size": obj.size,
                "action": "downloaded",
            }

        with ThreadPoolExecutor(max_workers=args.download_workers) as pool:
            futures = {pool.submit(download_one, item): item for item in planned}
            for done, future in enumerate(as_completed(futures), start=1):
                result = future.result()
                downloaded.append(result)
                print(
                    f"[supabase {done}/{len(planned)}] downloaded {result['objectPath']}",
                    flush=True,
                )
        downloaded.sort(key=lambda item: item["index"])
        for item in downloaded:
            item.pop("index", None)
    return {
        "skipped": False,
        "bucket": args.bucket,
        "prefix": args.prefix,
        "remoteCount": len(remote_objects),
        "downloaded": downloaded,
        "skippedExisting": skipped_existing,
    }


def build_index(args: argparse.Namespace, fps: float) -> dict[str, Any]:
    if args.dry_run:
        return {"skipped": True, "reason": "dry-run"}
    if not shutil.which("ffmpeg") or not shutil.which("ffprobe"):
        raise SystemExit("ffmpeg and ffprobe must be installed and available on PATH")
    paths = list_videos(args.videos_dir)
    if not paths:
        raise SystemExit(f"No supported videos found in {args.videos_dir}")
    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)

    previous = load_previous_manifest()
    video_files = build_video_files(paths, previous, args.hash_workers)
    duplicates = duplicate_report(video_files)
    seen_hashes: set[str] = set()
    included: list[VideoFile] = []
    skipped_exact: list[dict[str, str]] = []
    for video in video_files:
        if video.content_hash in seen_hashes:
            skipped_exact.append({"path": video.rel_path, "contentHash": video.content_hash})
            continue
        seen_hashes.add(video.content_hash)
        included.append(video)

    fps_token = cache_fps_token(fps)
    cache_sources = default_cache_sources(args)
    for source in cache_sources:
        if source.exists():
            print(f"[cache-source] {source}", flush=True)
    prepared_by_path: dict[Path, PreparedSignature] = {}
    action_counts: dict[str, int] = {}
    with ThreadPoolExecutor(max_workers=args.index_workers) as pool:
        futures = {
            pool.submit(prepare_signature, video, fps, fps_token, cache_sources): video
            for video in included
        }
        for done, future in enumerate(as_completed(futures), start=1):
            prepared = future.result()
            prepared_by_path[prepared.video.path] = prepared
            action_counts[prepared.action] = action_counts.get(prepared.action, 0) + 1
            print(
                f"[{prepared.action} {done}/{len(included)}] {prepared.video.rel_path} "
                f"({prepared.frame_count} frames, {prepared.elapsed_sec:.1f}s)",
                flush=True,
            )

    combined_tmp = SIGNATURES_PATH.with_suffix(".bin.tmp")
    frame_offset = 0
    videos_manifest: list[dict[str, Any]] = []
    with combined_tmp.open("wb") as combined:
        for index, video in enumerate(included, start=1):
            video_id = f"{slugify(video.path.stem)}-{video.content_hash[:8]}"
            prepared = prepared_by_path[video.path]
            with prepared.sig_path.open("rb") as handle:
                shutil.copyfileobj(handle, combined)
            videos_manifest.append(
                {
                    "videoId": video_id,
                    "path": video.rel_path,
                    "originalName": video.path.name,
                    "contentHash": video.content_hash,
                    "statSize": video.stat_size,
                    "statMtimeNs": video.stat_mtime_ns,
                    "duration": prepared.probe.get("duration"),
                    "width": prepared.probe.get("width"),
                    "height": prepared.probe.get("height"),
                    "sampleFps": fps,
                    "frameOffset": frame_offset,
                    "frameCount": prepared.frame_count,
                }
            )
            frame_offset += prepared.frame_count
            print(f"[combine {index}/{len(included)}] {video.rel_path}", flush=True)
    combined_tmp.replace(SIGNATURES_PATH)
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": utc_now(),
        "sourceDir": rel_to_pipeline(args.videos_dir),
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
        "indexActions": action_counts,
    }
    MANIFEST_PATH.write_text(json.dumps(manifest, indent=2) + "\n")
    print(
        f"Wrote {frame_offset} signatures from {len(videos_manifest)} unique video(s) "
        f"to {SIGNATURES_PATH.relative_to(PIPELINE_ROOT)}",
        flush=True,
    )
    if duplicates["exactDuplicates"] or duplicates["possibleDuplicateGroups"]:
        print(
            "Duplicate report: "
            f"{len(duplicates['exactDuplicates'])} exact, "
            f"{len(duplicates['possibleDuplicateGroups'])} possible groups",
            flush=True,
        )
    return {
        "skipped": False,
        "videoFiles": len(video_files),
        "uniqueVideos": len(videos_manifest),
        "frameCount": frame_offset,
        "exactDuplicates": len(duplicates["exactDuplicates"]),
        "possibleDuplicateGroups": len(duplicates["possibleDuplicateGroups"]),
        "actions": action_counts,
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sample-fps", type=float, default=None, help="sample FPS for signatures")
    parser.add_argument(
        "--workers",
        type=int,
        default=env_int("MOSAIC_WORKERS", default_worker_count()),
        help="default worker count for hash/download/index phases",
    )
    parser.add_argument(
        "--hash-workers",
        type=int,
        default=None,
        help="worker count for SHA-256 hashing; default is --workers",
    )
    parser.add_argument(
        "--download-workers",
        type=int,
        default=None,
        help="worker count for Supabase downloads; default is --workers",
    )
    parser.add_argument(
        "--index-workers",
        type=int,
        default=None,
        help="worker count for ffmpeg signature indexing; default is --workers",
    )
    parser.add_argument(
        "--local-source",
        action="append",
        default=[],
        help="local folder to import videos from; can be passed multiple times",
    )
    parser.add_argument(
        "--videos-dir",
        default=os.environ.get("MOSAIC_SOURCE_VIDEOS_DIR", str(DEFAULT_VIDEOS_DIR)),
        help="canonical source video folder; relative paths resolve from the repo root",
    )
    parser.add_argument(
        "--import-mode",
        choices=["hardlink", "copy", "symlink"],
        default=os.environ.get("MOSAIC_IMPORT_MODE", "hardlink"),
        help="how local videos are materialized into mosaic-pipeline/videos",
    )
    parser.add_argument("--skip-local-import", action="store_true")
    parser.add_argument("--skip-supabase", action="store_true")
    parser.add_argument("--index-only", action="store_true", help="skip sync and rebuild/reuse the index")
    parser.add_argument("--dry-run", action="store_true", help="plan sync without writing or indexing")
    parser.add_argument(
        "--bucket",
        default=os.environ.get("MOSAIC_CLIPS_BUCKET", "knicks-clips"),
        help="Supabase Storage bucket containing source videos",
    )
    parser.add_argument(
        "--prefix",
        default=os.environ.get("MOSAIC_VIDEOS_PREFIX", "videos"),
        help="Supabase Storage prefix containing source videos",
    )
    parser.add_argument(
        "--max-downloads",
        type=int,
        default=None,
        help="debug limit for Supabase downloads",
    )
    parser.add_argument(
        "--cache-source",
        action="append",
        default=[],
        help="existing signature cache directory to import from; can be passed multiple times",
    )
    args = parser.parse_args(argv)
    args.workers = max(1, int(args.workers))
    args.hash_workers = max(1, int(args.hash_workers or args.workers))
    args.download_workers = max(1, int(args.download_workers or args.workers))
    args.index_workers = max(1, int(args.index_workers or args.workers))
    args.videos_dir = resolve_repo_path(args.videos_dir)
    return args


def main(argv: list[str] | None = None) -> int:
    load_environment()
    args = parse_args(argv or sys.argv[1:])
    fps = parse_sample_fps(args.sample_fps)
    DATA_DIR.mkdir(parents=True, exist_ok=True)

    sync_report = {
        "schemaVersion": 1,
        "generatedAt": utc_now(),
        "sampleFps": fps,
        "local": import_local_videos(args),
        "supabase": sync_supabase_videos(args),
    }
    index_report = build_index(args, fps)
    sync_report["index"] = index_report
    SYNC_REPORT_PATH.write_text(json.dumps(sync_report, indent=2) + "\n")
    print(f"Wrote {SYNC_REPORT_PATH.relative_to(PIPELINE_ROOT)}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except subprocess.CalledProcessError as exc:
        print(exc, file=sys.stderr)
        if exc.stderr:
            print(exc.stderr, file=sys.stderr)
        raise SystemExit(exc.returncode)
