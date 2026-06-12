#!/usr/bin/env python3
"""Pick diverse key frames from the clips produced by 02-split-clips.py.

For every clip we sample candidate frames (default 1/sec), then greedily keep
the ones most different from everything already kept FROM THE SAME VIDEO —
farthest-point sampling over a color + composition feature:

  - a 4x4x4 RGB histogram ("color range covered")
  - a 16x9 mean-pooled grayscale signature ("same situation" detector)

Budget per clip is one frame per --sec-per-frame seconds (default 3s, so a
30s clip yields up to 10). Selection stops early once the best remaining
candidate is within --min-dist of an already-kept frame, so long footage
doesn't pile up near-duplicates: redundancy, not duration, is the limiter.
Every clip keeps at least one frame.

Outputs:
  data/key-frames/<videoId>/c<clip###>_s<source-sec>.jpg   (full-res)
  data/key-frames.json                                     (manifest)

Usage:
  python3 scripts/knicks/03-key-frames.py [--min-dist 0.10] [--dry-run]
"""

import argparse
import datetime
import json
import os
import shutil
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
DATA_DIR = SCRIPT_DIR / "data"
CLIPS_MANIFEST = DATA_DIR / "clips.json"
KEYFRAMES_DIR = DATA_DIR / "key-frames"
MANIFEST_PATH = DATA_DIR / "key-frames.json"
CACHE_DIR = DATA_DIR / ".keyframe-cache"

# Analysis resolution. 96x54 keeps 16:9 sources undistorted and is plenty for
# histograms; mean-pooling to 16x9 gives the composition signature.
ANA_W, ANA_H = 96, 54
SIG_W, SIG_H = 16, 9
HIST_BINS = 4  # per RGB channel -> 64 bins


# Clips longer than this decode keyframes only (~every 5s) instead of every
# frame. Full AV1 decode of multi-minute chapters is by far the slowest step,
# and on long footage the redundancy threshold — not candidate density — is
# what limits the final selection anyway.
KEYFRAME_ONLY_ABOVE_SEC = 600


def sample_candidates(clip, fps):
    """Decode a clip into (N, ANA_H, ANA_W, 3) uint8 frames + timestamps."""
    keyframes_only = clip["duration"] > KEYFRAME_ONLY_ABOVE_SEC
    if keyframes_only:
        in_args = ["-skip_frame", "nokey"]
        vf = f"scale={ANA_W}:{ANA_H}"
        out_args = ["-fps_mode", "passthrough"]
    else:
        in_args = []
        vf = f"fps={fps},scale={ANA_W}:{ANA_H}"
        out_args = []
    proc = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error",
            *in_args, "-i", clip["path"],
            "-vf", vf, *out_args,
            "-f", "rawvideo", "-pix_fmt", "rgb24", "-",
        ],
        capture_output=True, check=True,
    )
    buf = np.frombuffer(proc.stdout, dtype=np.uint8)
    frame_len = ANA_W * ANA_H * 3
    n = len(buf) // frame_len
    frames = buf[: n * frame_len].reshape(n, ANA_H, ANA_W, 3)
    if keyframes_only:
        # Keyframe pts aren't in the raw stream; probe them separately.
        times = probe_keyframe_times(clip["path"])[:n]
        if len(times) < n:
            times = times + [clip["duration"] * (i + 0.5) / n for i in range(len(times), n)]
    else:
        times = (np.arange(n) / fps).tolist()  # frame i shows ~t=i/fps
    return frames, times


def probe_keyframe_times(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "packet=pts_time,flags", "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    times = []
    for line in out.splitlines():
        parts = line.split(",")
        if len(parts) >= 2 and "K" in parts[1] and parts[0] not in ("N/A", ""):
            times.append(float(parts[0]))
    times.sort()
    return times


def features(frames):
    """Per-frame feature dict: normalized RGB histogram + gray signature."""
    n = len(frames)
    if n == 0:
        return np.zeros((0, HIST_BINS**3)), np.zeros((0, SIG_H * SIG_W))
    # Histogram: quantize each channel into HIST_BINS buckets.
    q = (frames.astype(np.uint16) * HIST_BINS // 256).astype(np.uint16)
    flat = q[..., 0] * HIST_BINS * HIST_BINS + q[..., 1] * HIST_BINS + q[..., 2]
    hists = np.zeros((n, HIST_BINS**3), dtype=np.float32)
    for i in range(n):
        hists[i] = np.bincount(flat[i].ravel(), minlength=HIST_BINS**3)
    hists /= ANA_W * ANA_H
    # Signature: grayscale mean-pooled to SIG_H x SIG_W, scaled to 0..1.
    gray = frames.astype(np.float32).mean(axis=3)
    sig = gray.reshape(n, SIG_H, ANA_H // SIG_H, SIG_W, ANA_W // SIG_W).mean(axis=(2, 4))
    sig = (sig / 255.0).reshape(n, -1)
    return hists, sig


def dist_to_one(hists, sigs, hist_one, sig_one):
    """Distance from every candidate to a single selected frame."""
    # Histogram half-L1 is 0..1; signature RMS difference is 0..1.
    d_hist = 0.5 * np.abs(hists - hist_one[None, :]).sum(axis=1)
    d_sig = np.sqrt(((sigs - sig_one[None, :]) ** 2).mean(axis=1))
    return 0.5 * d_hist + 0.5 * d_sig


def min_dist_to_set(hists, sigs, hist_sel, sig_sel, chunk=256):
    """Min distance from each candidate to a selected set, chunked over the set."""
    dmin = np.full(len(hists), np.inf, dtype=np.float32)
    for lo in range(0, len(hist_sel), chunk):
        hs, ss = hist_sel[lo:lo + chunk], sig_sel[lo:lo + chunk]
        d_hist = 0.5 * np.abs(hists[:, None, :] - hs[None, :, :]).sum(axis=2)
        d_sig = np.sqrt(((sigs[:, None, :] - ss[None, :, :]) ** 2).mean(axis=2))
        dmin = np.minimum(dmin, (0.5 * d_hist + 0.5 * d_sig).min(axis=1))
    return dmin


def colorfulness(frames):
    """Seed heuristic: pixel channel spread + luma variance, higher = livelier."""
    f = frames.astype(np.float32)
    spread = (f.max(axis=3) - f.min(axis=3)).mean(axis=(1, 2)) / 255.0
    contrast = f.mean(axis=3).std(axis=(1, 2)) / 255.0
    return spread + contrast


def analyze_clip(clip, fps):
    """Decode + featurize one clip, with an on-disk cache keyed by file mtime."""
    src = Path(clip["path"])
    cache_key = f"{clip['videoId']}_{clip['index']:03d}_{int(src.stat().st_mtime)}_{fps:g}.npz"
    cache_path = CACHE_DIR / cache_key
    if cache_path.exists():
        z = np.load(cache_path)
        return {"times": z["times"], "hists": z["hists"],
                "sigs": z["sigs"], "color": z["color"]}
    frames, times = sample_candidates(clip, fps)
    hists, sigs = features(frames)
    color = colorfulness(frames) if len(frames) else np.zeros(0, dtype=np.float32)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(
        cache_path,
        times=np.asarray(times, dtype=np.float64),
        hists=hists.astype(np.float32),
        sigs=sigs.astype(np.float32),
        color=color.astype(np.float32),
    )
    return {"times": np.asarray(times), "hists": hists, "sigs": sigs, "color": color}


def extract_full_frame(src_path, t, out_path):
    out_path.parent.mkdir(parents=True, exist_ok=True)
    # Keyframe pts can land a hair past the clip's nominal end; back off until
    # ffmpeg actually emits a frame.
    for t_try in (t, max(0.0, t - 1.0), max(0.0, t - 3.0)):
        subprocess.run(
            [
                "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
                "-ss", f"{t_try:.3f}", "-i", src_path,
                "-frames:v", "1", "-q:v", "2", str(out_path),
            ],
            check=False, capture_output=True,
        )
        if out_path.exists() and out_path.stat().st_size > 0:
            return
    raise RuntimeError(f"could not extract frame at {t:.1f}s from {src_path}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--min-dist", type=float, default=0.10,
                        help="redundancy threshold; smaller keeps more, similar frames")
    parser.add_argument("--sec-per-frame", type=float, default=3.0,
                        help="budget: at most one frame per this many seconds of clip")
    parser.add_argument("--candidate-fps", type=float, default=1.0,
                        help="how densely to sample candidate frames")
    parser.add_argument("--jobs", type=int,
                        default=max(1, (os.cpu_count() or 4) // 2))
    parser.add_argument("--dry-run", action="store_true",
                        help="analyze + report counts, skip full-res extraction")
    args = parser.parse_args()

    if not CLIPS_MANIFEST.exists():
        sys.exit("error: data/clips.json not found — run 02-split-clips.py first")
    clips = json.loads(CLIPS_MANIFEST.read_text())["clips"]

    by_video = {}
    for clip in clips:
        by_video.setdefault(clip["videoId"], []).append(clip)
    for vclips in by_video.values():
        vclips.sort(key=lambda c: c["index"])

    print(f"Analyzing {len(clips)} clips from {len(by_video)} videos "
          f"(candidates @ {args.candidate_fps}/s, min-dist {args.min_dist})")

    # Decode + featurize candidates in parallel across clips (cached on disk,
    # so re-runs with different selection params skip the decode entirely).
    analyzed = {}
    decoded = 0
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futs = {
            pool.submit(analyze_clip, clip, args.candidate_fps): id(clip)
            for clip in clips
        }
        for fut in as_completed(futs):
            analyzed[futs[fut]] = fut.result()
            decoded += 1
            if decoded % 20 == 0 or decoded == len(clips):
                print(f"  decoded {decoded}/{len(clips)} clips", flush=True)

    selected = []  # manifest entries
    for vid, vclips in by_video.items():
        hist_sel = []  # selected features for this video, list of 1D arrays
        sig_sel = []
        kept_in_video = 0
        for clip in vclips:
            cand = analyzed[id(clip)]
            times, hists, sigs = cand["times"], cand["hists"], cand["sigs"]
            n = len(times)
            if n == 0:
                print(f"  warn: no frames decoded for {clip['path']}")
                continue
            budget = max(1, int(clip["duration"] // args.sec_per_frame))

            # dmin[i] = distance from candidate i to the nearest already-kept
            # frame of this video; updated incrementally as we pick.
            if hist_sel:
                dmin = min_dist_to_set(
                    hists, sigs, np.asarray(hist_sel), np.asarray(sig_sel)
                )
            else:
                dmin = np.full(n, np.inf, dtype=np.float32)
            available = np.ones(n, dtype=bool)

            picked = []
            while len(picked) < budget and available.any():
                idxs = np.flatnonzero(available)
                if np.isinf(dmin[idxs]).all():
                    # Nothing kept for this video yet: seed with the liveliest frame.
                    best = int(idxs[np.argmax(cand["color"][idxs])])
                    score = float("inf")
                else:
                    j = int(np.argmax(dmin[idxs]))
                    best, score = int(idxs[j]), float(dmin[idxs][j])
                if picked and score < args.min_dist:
                    break  # everything left is redundant
                # First frame of a clip is always kept, even if it echoes
                # earlier footage — each clip is a distinct play.
                picked.append((best, score))
                hist_sel.append(hists[best])
                sig_sel.append(sigs[best])
                available[best] = False
                dmin = np.minimum(
                    dmin, dist_to_one(hists, sigs, hists[best], sigs[best])
                )

            for idx, score in picked:
                t_clip = float(times[idx])
                t_source = clip["start"] + t_clip
                out_path = (
                    KEYFRAMES_DIR / vid /
                    f"c{clip['index']:03d}_s{t_source:07.1f}.jpg"
                )
                selected.append({
                    "videoId": vid,
                    "clipIndex": clip["index"],
                    "clipPath": clip["path"],
                    "tClip": round(t_clip, 3),
                    "tSource": round(t_source, 3),
                    "noveltyScore": None if score == float("inf") else round(score, 4),
                    "path": str(out_path),
                })
            kept_in_video += len(picked)
        total_candidates = sum(len(analyzed[id(c)]["times"]) for c in vclips)
        print(f"  {vid}: kept {kept_in_video} of {total_candidates} candidates "
              f"across {len(vclips)} clips", flush=True)

    print(f"Selected {len(selected)} key frames total")
    if args.dry_run:
        return

    if KEYFRAMES_DIR.exists():
        shutil.rmtree(KEYFRAMES_DIR)
    done = 0
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futs = [
            pool.submit(extract_full_frame, e["clipPath"], e["tClip"], Path(e["path"]))
            for e in selected
        ]
        for fut in futs:
            fut.result()
            done += 1
            if done % 100 == 0 or done == len(selected):
                print(f"  extracted {done}/{len(selected)}")

    MANIFEST_PATH.write_text(json.dumps({
        "generatedAt": datetime.datetime.now().astimezone().isoformat(),
        "params": {
            "minDist": args.min_dist,
            "secPerFrame": args.sec_per_frame,
            "candidateFps": args.candidate_fps,
        },
        "frames": selected,
    }, indent=2) + "\n")
    print(f"Wrote manifest with {len(selected)} frames to {MANIFEST_PATH}")


if __name__ == "__main__":
    main()
