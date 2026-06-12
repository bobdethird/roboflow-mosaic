#!/usr/bin/env python3
"""Detect clip boundaries in videos-2 sources with a vision LLM, then cut.

Supports OpenAI (default, gpt-5.5 with detail=low images) and Gemini
(--provider gemini, gemini-3.5-flash) — same prompts, schema, and cache.

For every video in data/videos-2/manifest.json:

  1. Extract one frame per second at 640px long edge (cheap on tokens).
  2. Send frames to Gemini in small batches and ask, per frame, whether a NEW
     clip/highlight has started. The prompt leans hard on the score bug:
     we track the last score seen, and an unchanged (or absent) score means
     we're still inside the same highlight or watching its replay. Fan-tier
     videos get a different prompt (scene/location changes, no score logic).
  3. Each frame is also flagged as hype/key or not (dunk, shot going in,
     block, crowd eruption) with a short description — the hype timeline is
     written to auto-marks.json and each clip carries its hype timestamps,
     ready for thumbnail/key-frame selection downstream.
  4. After a boundary is confirmed, skip the next --buffer seconds without
     calling the API at all — a clip is never that short, and the skipped
     frames are pure savings.
  5. Cut clips with ffmpeg and write manifests.

Every model response is cached to data/videos-2/.gemini/<id>.<provider>.<model>.jsonl
keyed by timestamp, so reruns replay the matching model cache and only pay for
unseen frames.

Outputs:
  data/videos-2/.frames/<videoId>/t%06d.jpg      (1fps 640px frames, cached)
  data/videos-2/.gemini/<videoId>.<provider>.<model>.jsonl (per-frame verdicts)
  data/videos-2/auto-marks.json                  (boundaries + score timeline)
  data/videos-2/clips/<videoId>/<nnn>_<s>-<e>.mp4
  data/videos-2/clips.json                       (clip manifest)

Usage:
  pip install openai          (default provider; google-genai for --provider gemini)
  export OPENAI_API_KEY=...   (or put it in .env.local / pass --api-key)
  python3 scripts/knicks/detect-clips.py [--videos id1,id2] [--limit-sec 120]
      [--batch 10] [--buffer 5] [--model gemini-3.5-flash]
      [--dry-run] [--no-cut] [--force]
"""

import argparse
import base64
import datetime
import json
import os
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent.parent
DATA_DIR = SCRIPT_DIR / "data" / "videos-2"
MANIFEST_PATH = DATA_DIR / "manifest.json"
FRAMES_DIR = DATA_DIR / ".frames"
GEMINI_CACHE_DIR = DATA_DIR / ".gemini"
MARKS_PATH = DATA_DIR / "auto-marks.json"
CLIPS_DIR = DATA_DIR / "clips"
CLIPS_MANIFEST_PATH = DATA_DIR / "clips.json"

DEFAULT_MODELS = {
    "openai": "gpt-5.5",
    "gemini": "gemini-3.5-flash",
}
API_KEY_ENV = {"openai": "OPENAI_API_KEY", "gemini": "GEMINI_API_KEY"}

# Strict per-frame response schema (standard JSON Schema). All properties are
# required with nullable types so it satisfies OpenAI strict structured
# outputs; Gemini consumes the same schema via response_json_schema.
FRAME_SCHEMA = {
    "type": "object",
    "properties": {
        "t": {"type": "integer"},
        "new_clip": {"type": "boolean"},
        "score_visible": {"type": "boolean"},
        "score": {"type": ["string", "null"]},
        "scene": {
            "type": "string",
            "enum": ["live", "replay", "crowd", "studio", "graphic", "other"],
        },
        "hype": {"type": "boolean"},
        "hype_what": {"type": ["string", "null"]},
    },
    "required": [
        "t", "new_clip", "score_visible", "score", "scene", "hype", "hype_what",
    ],
    "additionalProperties": False,
}
RESPONSE_SCHEMA = {"type": "array", "items": FRAME_SCHEMA}
# OpenAI strict mode requires a top-level object, so the array is wrapped.
OPENAI_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {"frames": RESPONSE_SCHEMA},
    "required": ["frames"],
    "additionalProperties": False,
}

GAMEPLAY_PROMPT = """\
You are segmenting a New York Knicks basketball highlights video into clips.
The frames below were sampled at 1 frame per second and are labeled with their
timestamp in seconds. Decide, for EACH frame, whether a NEW clip/highlight has
just started at that frame.

How to tell a new clip has started — in priority order:

1. THE SCORE BUG IS THE STRONGEST SIGNAL. The last score we saw is:
   {last_score}. If a frame shows a score graphic with a DISCONTINUOUS
   score — different team names, points that jumped by more than 3, points
   that went DOWN, or a far-off quarter/game clock — a new highlight has
   very likely started.
2. CAREFUL: a score change does NOT always mean a new clip. When the score
   ticks up by just 1, 2, or 3 for one team (same teams, clock continuous),
   that is the featured play itself scoring — the bug updates right before
   the video moves on to the next highlight. That moment is still part of
   the SAME clip; do not split on it.
3. If the score bug shows the SAME score as the last known score, we are
   still inside the SAME play. Do not mark a new clip.
4. If NO score bug is visible, the broadcast is usually showing a replay or
   celebration of the SAME highlight. Stay in the same clip — a camera cut,
   slow-motion replay, crowd shot, or bench reaction is NOT a new clip.
5. Other strong signals of a new clip: different arena or court, different
   uniforms (a different game), an interview/studio/graphic segment starting,
   or the game situation jumping (e.g. quarter changes).

Current state: we are inside a clip that started at t={clip_start}s.
Last known score: {last_score}.

For each frame, if a score graphic is legible, transcribe it into "score" as
"<away> <pts> - <home> <pts> Q<n> <clock>" (omit parts you cannot read).

Also mark whether the frame is a HYPE / KEY moment ("hype": true) — the peak
action of a highlight, the frame you would pick as the thumbnail:
 - a player dunking or finishing at the rim (ball near/above the rim),
 - a shot being released or going through the net,
 - a big block, steal, or poster moment mid-air,
 - a buzzer-beater or wild celebration right after a made basket.
Set-up dribbling, passing, inbounds, free-throw routines, walking up court,
timeouts, and talking heads are NOT hype frames. When "hype" is true, say
what is happening in 2-6 words in "hype_what" (e.g. "Brunson dunks over
defender", "three-pointer splashes"); otherwise set it to null.

Frames labeled "reference frame (context only)" come immediately BEFORE the
first frame you must judge. Use them as the visual baseline — especially to
decide whether the FIRST judged frame starts a new clip — but do NOT return
entries for them.

Return a JSON array with EXACTLY one object per judged frame, in the same
order as the frames.
"""

FAN_PROMPT = """\
You are segmenting fan/crowd footage (watch parties, street celebrations,
arena crowds) related to the New York Knicks into clips. The frames below
were sampled at 1 frame per second and are labeled with their timestamp in
seconds. Decide, for EACH frame, whether a NEW clip/scene has just started.

This is NOT broadcast basketball: score graphics rarely appear and do NOT
drive clip boundaries here. A new clip means a clearly different scene:
 - a different location (street vs bar vs arena vs rooftop),
 - day vs night,
 - indoor vs outdoor,
 - a clearly different crowd / group of people,
 - an obvious hard cut to unrelated content (titles, interviews, gameplay).

Gradual camera movement, panning across the same crowd, or zooming within
the same scene is NOT a new clip.

Current state: we are inside a clip that started at t={clip_start}s.

If a basketball score graphic happens to be legible, transcribe it into
"score".

Also mark whether the frame is a HYPE / KEY moment ("hype": true) — peak
crowd energy, the frame you would pick as the thumbnail:
 - a crowd erupting, jumping, or arms in the air at once,
 - hugging, dogpiles, people climbing on things, flares/confetti,
 - a packed street or bar at the loudest-looking moment.
Calm milling around, people watching quietly, transitions, and b-roll are
NOT hype frames. When "hype" is true, say what is happening in 2-6 words in
"hype_what" (e.g. "bar erupts after game-winner"); otherwise set it to null.

Frames labeled "reference frame (context only)" come immediately BEFORE the
first frame you must judge. Use them as the visual baseline — especially to
decide whether the FIRST judged frame starts a new clip — but do NOT return
entries for them.

Return a JSON array with EXACTLY one object per judged frame, in the same
order as the frames.
"""


def load_api_key(cli_key, env_name):
    if cli_key:
        return cli_key
    key = os.environ.get(env_name)
    if key:
        return key
    # Fall back to repo env files without exporting anything.
    for name in (".env.local", ".env"):
        env_path = REPO_ROOT / name
        if not env_path.exists():
            continue
        for line in env_path.read_text().splitlines():
            m = re.match(rf"^\s*{env_name}\s*=\s*(.+?)\s*$", line)
            if m:
                return m.group(1).strip("'\"")
    sys.exit(
        f"error: no API key. Set {env_name}, add it to .env.local, "
        "or pass --api-key."
    )


def ffprobe_duration(path: Path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return float(out)


def extract_frames(video, limit_sec=None):
    """Extract 1fps 640px-long-edge JPEGs. Cached: skips if already complete."""
    out_dir = FRAMES_DIR / video["id"]
    duration = video["duration"]
    expect = int(min(duration, limit_sec) if limit_sec else duration)
    have = len(list(out_dir.glob("t*.jpg"))) if out_dir.exists() else 0
    # 1fps yields ~duration frames; tolerate the off-by-one at the tail.
    # Cap at `expect` so --limit-sec holds even when more frames exist on disk.
    if have >= expect - 1 and have > 0:
        return out_dir, min(have, expect)
    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob("t*.jpg"):
        stale.unlink()
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    if limit_sec:
        args += ["-t", str(limit_sec)]
    args += [
        "-i", video["path"],
        "-vf", "fps=1,scale='if(gt(iw,ih),640,-2)':'if(gt(iw,ih),-2,640)'",
        "-q:v", "4", "-start_number", "0",
        str(out_dir / "t%06d.jpg"),
    ]
    subprocess.run(args, check=True)
    return out_dir, len(list(out_dir.glob("t*.jpg")))


# Verdicts are cached per provider and model so side-by-side comparisons on the
# same footage never replay another model's answers.
_cache_lock = threading.Lock()


def cache_model_key(model):
    return re.sub(r"[^A-Za-z0-9._-]+", "-", model).strip("-") or "default"


def cache_path(video_id, provider, model):
    return GEMINI_CACHE_DIR / f"{video_id}.{provider}.{cache_model_key(model)}.jsonl"


def load_cache(video_id, provider, model):
    path = cache_path(video_id, provider, model)
    cache = {}
    if path.exists():
        for line in path.read_text().splitlines():
            if not line.strip():
                continue
            entry = json.loads(line)
            cache[int(entry["t"])] = entry
    return cache


def append_cache(video_id, provider, model, entries):
    GEMINI_CACHE_DIR.mkdir(parents=True, exist_ok=True)
    with _cache_lock:
        with cache_path(video_id, provider, model).open("a") as f:
            for entry in entries:
                f.write(json.dumps(entry) + "\n")


# --- Score parsing for the discontinuity failsafe -------------------------
#
# Models reliably TRANSCRIBE the score bug even when they fail to flag
# new_clip at batch edges (verified on cached verdicts: every missed boundary
# had a correct score transcription at that exact frame). So we parse the
# transcription and force a boundary on a score DISCONTINUITY — while an
# incremental change (+1..3 to one side, same teams) is the featured play
# scoring and must NOT split the clip.

NON_TEAM_TOKENS = {"HT", "OT", "HALF", "HALFTIME", "FINAL", "END"}


def parse_score(text):
    """Extract {teams, points, quarter} from a transcribed score bug.

    Tolerates partial reads ("13 - 17"), flipped team order, and clock noise.
    Returns None when there aren't two readable point values.
    """
    if not text:
        return None
    up = text.upper()
    quarter = None
    m = re.search(r"\bQ([1-4])\b|\b([1-4])(?:ST|ND|RD|TH)\b", up)
    if m:
        quarter = int(m.group(1) or m.group(2))
    elif re.search(r"\bOT\b", up):
        quarter = 5
    # Integers that are not part of a clock reading (4:59, 1.8) or quarter tag.
    points = [
        int(n)
        for n in re.findall(r"(?<![:.\dQ])(\d{1,3})(?![:.\d])", up)
        if int(n) <= 200
    ]
    if len(points) < 2:
        return None
    teams = {
        tok for tok in re.findall(r"\b[A-Z]{2,4}\b", up)
        if tok not in NON_TEAM_TOKENS
    }
    return {"teams": teams, "points": tuple(sorted(points[:2])), "quarter": quarter}


def score_discontinuity(prev, cur):
    """True when the score change cannot happen within a single play."""
    if not prev or not cur:
        return False
    if prev["teams"] and cur["teams"] and prev["teams"].isdisjoint(cur["teams"]):
        return True  # different game entirely
    (a0, a1), (b0, b1) = prev["points"], cur["points"]
    d0, d1 = b0 - a0, b1 - a1
    if d0 < 0 or d1 < 0:
        return True  # scores never decrease within a game
    if d0 > 3 or d1 > 3:
        return True  # bigger than any single play
    # No quarter-regression rule: models misread the quarter often enough
    # (verified: "Q2"->"Q1" jitter within one clip) that it false-positives,
    # and every genuine regression also moves teams or points.
    return False


def realign_timestamps(results, frames, n_context=0):
    """Trust our frame order over the model's copied labels.

    If the model returned entries for the context frames despite instructions,
    drop the leading extras so judged frames stay aligned.
    """
    if n_context and len(results) == len(frames) + n_context:
        results = results[n_context:]
    for result, (t, _) in zip(results, frames):
        result["t"] = t
    return results[:len(frames)]


class OpenAIClient:
    def __init__(self, api_key, model, detail="low"):
        from openai import OpenAI  # lazy: only needed for this provider

        self.client = OpenAI(api_key=api_key, timeout=120.0, max_retries=5)
        self.model = model
        self.detail = detail
        self.prompt_tokens = 0
        self.output_tokens = 0
        self.requests_made = 0

    def analyze_batch(self, prompt, frames, context=()):
        """frames: [(t, jpeg_path)] to judge; context: reference-only frames
        immediately preceding them. Returns list of per-frame dicts."""
        content = [{"type": "input_text", "text": prompt}]
        for t, path in context:
            b64 = base64.b64encode(path.read_bytes()).decode()
            content.append({
                "type": "input_text",
                "text": f"reference frame at t={t}s (context only — do NOT "
                        "include it in your output):",
            })
            content.append({
                "type": "input_image",
                "image_url": f"data:image/jpeg;base64,{b64}",
                "detail": self.detail,
            })
        for t, path in frames:
            b64 = base64.b64encode(path.read_bytes()).decode()
            content.append({"type": "input_text", "text": f"frame at t={t}s:"})
            content.append({
                "type": "input_image",
                "image_url": f"data:image/jpeg;base64,{b64}",
                "detail": self.detail,
            })
        response = self.client.responses.create(
            model=self.model,
            input=[{"role": "user", "content": content}],
            reasoning={"effort": "low"},
            text={
                "format": {
                    "type": "json_schema",
                    "name": "frame_verdicts",
                    "schema": OPENAI_RESPONSE_SCHEMA,
                    "strict": True,
                }
            },
        )
        usage = response.usage
        if usage:
            self.prompt_tokens += usage.input_tokens or 0
            self.output_tokens += usage.output_tokens or 0
        self.requests_made += 1
        results = json.loads(response.output_text)["frames"]
        if not isinstance(results, list):
            raise ValueError(
                f"expected JSON array, got: {response.output_text[:200]}"
            )
        return realign_timestamps(results, frames, len(context))


class GeminiClient:
    def __init__(self, api_key, model):
        from google import genai  # lazy: only needed for this provider
        from google.genai import errors as genai_errors
        from google.genai import types as genai_types

        self.errors = genai_errors
        self.types = genai_types
        self.client = genai.Client(api_key=api_key)
        self.model = model
        self.config = genai_types.GenerateContentConfig(
            response_mime_type="application/json",
            response_json_schema=RESPONSE_SCHEMA,
            temperature=0.0,
            http_options=genai_types.HttpOptions(timeout=120_000),
        )
        self.prompt_tokens = 0
        self.output_tokens = 0
        self.requests_made = 0

    def analyze_batch(self, prompt, frames, context=()):
        """frames: [(t, jpeg_path)] to judge; context: reference-only frames
        immediately preceding them. Returns list of per-frame dicts."""
        contents = [prompt]
        for t, path in context:
            contents.append(
                f"reference frame at t={t}s (context only — do NOT include "
                "it in your output):"
            )
            contents.append(
                self.types.Part.from_bytes(
                    data=path.read_bytes(), mime_type="image/jpeg"
                )
            )
        for t, path in frames:
            contents.append(f"frame at t={t}s:")
            contents.append(
                self.types.Part.from_bytes(
                    data=path.read_bytes(), mime_type="image/jpeg"
                )
            )
        delay = 2.0
        last_error = None
        for attempt in range(6):
            try:
                response = self.client.models.generate_content(
                    model=self.model, contents=contents, config=self.config
                )
            except self.errors.APIError as err:
                if err.code in (429, 500, 503):
                    last_error = err
                    time.sleep(delay)
                    delay = min(delay * 2, 60)
                    continue
                raise
            usage = response.usage_metadata
            if usage:
                self.prompt_tokens += usage.prompt_token_count or 0
                self.output_tokens += usage.candidates_token_count or 0
            self.requests_made += 1
            results = json.loads(response.text)
            if not isinstance(results, list):
                raise ValueError(f"expected JSON array, got: {response.text[:200]}")
            return realign_timestamps(results, frames, len(context))
        raise RuntimeError(f"Gemini request failed after retries: {last_error}")


# Reference frames prepended to each batch so the FIRST judged frame has a
# visual predecessor. Without these, neither provider ever detected a boundary
# at in-batch index 0-1 (verified on cached verdicts) — "did a new clip start?"
# is a comparison, and the first frame of a request had nothing to compare to.
CONTEXT_OVERLAP = 2


def context_for(frames_dir, first_t):
    out = []
    for dt in range(CONTEXT_OVERLAP, 0, -1):
        ts = first_t - dt
        path = frames_dir / f"t{ts:06d}.jpg"
        if ts >= 0 and path.exists():
            out.append((ts, path))
    return out


def prefetch_parallel(video, frames_dir, n_frames, client, args, cache):
    """Analyze all uncached frames with --parallel concurrent requests.

    Parallel batches can't carry running score state (they don't know what
    earlier batches saw), so the prompt marks the state unknown; the model
    still compares the 1fps frames within each batch. The sequential replay
    afterwards rebuilds the score timeline locally from cached verdicts.
    """
    is_fan = video.get("tier") == "fan"
    prompt_tpl = FAN_PROMPT if is_fan else GAMEPLAY_PROMPT
    prompt = prompt_tpl.format(
        last_score="unknown (this batch may start mid-clip)",
        clip_start="unknown",
    )

    def frame_path(sec):
        return frames_dir / f"t{sec:06d}.jpg"

    pending = [
        t for t in range(n_frames)
        if t not in cache and frame_path(t).exists()
    ]
    batches = [
        pending[i:i + args.batch] for i in range(0, len(pending), args.batch)
    ]
    if not batches:
        return
    print(f"  prefetch: {len(pending)} frames in {len(batches)} batches "
          f"({args.parallel} parallel)")

    def work(batch_ts):
        results = client.analyze_batch(
            prompt,
            [(ts, frame_path(ts)) for ts in batch_ts],
            context=context_for(frames_dir, batch_ts[0]),
        )
        append_cache(video["id"], args.provider, args.model, results)
        return results

    done = 0
    with ThreadPoolExecutor(max_workers=args.parallel) as pool:
        futures = {pool.submit(work, b): b for b in batches}
        for future in as_completed(futures):
            for result in future.result():
                cache[int(result["t"])] = result
            done += 1
            if done % 10 == 0 or done == len(batches):
                print(f"    {done}/{len(batches)} batches")


def detect_boundaries(video, frames_dir, n_frames, client, args):
    """Walk the 1fps timeline, batching API calls, tracking score state."""
    cache = load_cache(video["id"], args.provider, args.model)
    if client is not None and args.parallel > 1:
        prefetch_parallel(video, frames_dir, n_frames, client, args, cache)
    is_fan = video.get("tier") == "fan"

    boundaries = [0]
    score_events = []  # [{t, score}] every time a NEW score string is seen
    hype_events = []  # [{t, what, scene}] frames flagged as hype/key moments
    failsafe_events = []  # boundaries forced by score discontinuity
    last_score = None
    last_parsed = None
    clip_start = 0
    t = 0
    analyzed = 0

    def frame_path(sec):
        return frames_dir / f"t{sec:06d}.jpg"

    while t < n_frames:
        batch_ts = []
        cursor = t
        while cursor < n_frames and len(batch_ts) < args.batch:
            if frame_path(cursor).exists():
                batch_ts.append(cursor)
            cursor += 1
        if not batch_ts:
            break

        if all(ts in cache for ts in batch_ts):
            results = [cache[ts] for ts in batch_ts]
        else:
            prompt_tpl = FAN_PROMPT if is_fan else GAMEPLAY_PROMPT
            prompt = prompt_tpl.format(
                last_score=last_score or "not seen yet",
                clip_start=clip_start,
            )
            results = client.analyze_batch(
                prompt,
                [(ts, frame_path(ts)) for ts in batch_ts],
                context=context_for(frames_dir, batch_ts[0]),
            )
            append_cache(
                video["id"], args.provider, args.model,
                [r for r in results if r["t"] not in cache],
            )
            for r in results:
                cache[r["t"]] = r

        analyzed += len(results)
        boundary_hit = None
        for result in results:
            ts = int(result["t"])
            score = (result.get("score") or "").strip() or None
            forced = False
            if result.get("score_visible") and score:
                parsed = parse_score(score)
                # Failsafe: a score discontinuity is a boundary even when the
                # model failed to flag new_clip (fan footage exempt — a TV in
                # the background showing another game is not a scene change).
                if (
                    not is_fan
                    and not result.get("new_clip")
                    and ts > clip_start
                    and score_discontinuity(last_parsed, parsed)
                ):
                    forced = True
                if parsed:
                    last_parsed = parsed
                if score != last_score:
                    last_score = score
                    score_events.append({"t": ts, "score": score})
            if result.get("hype"):
                hype_events.append({
                    "t": ts,
                    "what": (result.get("hype_what") or "").strip() or None,
                    "scene": result.get("scene"),
                })
            if forced:
                failsafe_events.append({"t": ts, "score": score})
            if (result.get("new_clip") or forced) and ts > clip_start:
                boundary_hit = ts
                break

        if boundary_hit is not None:
            boundaries.append(boundary_hit)
            clip_start = boundary_hit
            # Buffer: a clip is never just a few seconds, skip ahead for free.
            t = boundary_hit + args.buffer
        else:
            t = batch_ts[-1] + 1

    duration = video["duration"]
    spans = []
    for i, start in enumerate(boundaries):
        end = boundaries[i + 1] if i + 1 < len(boundaries) else duration
        if end - start >= args.min_clip_sec:
            spans.append((float(start), float(min(end, duration))))
    return spans, score_events, hype_events, failsafe_events, analyzed


def clip_output_path(video_id, index, start, end):
    return CLIPS_DIR / video_id / f"{index:03d}_{int(start)}-{int(end)}.mp4"


def cut_clip(video, index, start, end, force):
    out_path = clip_output_path(video["id"], index, start, end)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.exists() and not force:
        return "skipped"
    tmp_path = out_path.with_suffix(".tmp.mp4")
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-ss", f"{start:.3f}", "-i", video["path"],
            "-t", f"{end - start:.3f}",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            str(tmp_path),
        ],
        check=True,
    )
    tmp_path.rename(out_path)
    return "encoded"


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--videos", help="comma-separated video ids (default: all)")
    parser.add_argument("--limit-sec", type=int, help="analyze only the first N seconds")
    parser.add_argument("--batch", type=int, default=10, help="frames per API call")
    parser.add_argument("--buffer", type=int, default=5,
                        help="seconds skipped after each detected boundary")
    parser.add_argument("--parallel", type=int, default=1,
                        help="concurrent API requests; >1 analyzes every frame "
                             "up-front (loses buffer-skip savings, much faster)")
    parser.add_argument("--min-clip-sec", type=int, default=3,
                        help="drop clips shorter than this")
    parser.add_argument("--provider", choices=["openai", "gemini"], default="openai")
    parser.add_argument("--model", help="model id (default: per-provider cheap model)")
    parser.add_argument("--detail", choices=["low", "high"], default="low",
                        help="OpenAI image detail; low = flat 85 tokens/frame")
    parser.add_argument("--api-key",
                        help="API key (else OPENAI_API_KEY / GEMINI_API_KEY / .env.local)")
    parser.add_argument("--dry-run", action="store_true",
                        help="extract frames and print the plan; no API calls, no cuts")
    parser.add_argument("--no-cut", action="store_true", help="detect only, skip ffmpeg cuts")
    parser.add_argument("--force", action="store_true", help="recut existing clips")
    parser.add_argument("--jobs", type=int, default=max(1, (os.cpu_count() or 4) // 2))
    args = parser.parse_args()

    if not MANIFEST_PATH.exists():
        sys.exit(f"error: {MANIFEST_PATH} not found")
    manifest = json.loads(MANIFEST_PATH.read_text())
    videos = manifest["videos"]
    if args.videos:
        wanted = set(args.videos.split(","))
        videos = [v for v in videos if v["id"] in wanted]
        missing = wanted - {v["id"] for v in videos}
        if missing:
            sys.exit(f"error: ids not in manifest: {', '.join(sorted(missing))}")
    if not videos:
        sys.exit("error: no videos selected")

    for video in videos:
        if not Path(video["path"]).is_absolute():
            video["path"] = str(REPO_ROOT / video["path"])
        if not Path(video["path"]).exists():
            sys.exit(f"error: missing video file {video['path']}")
        if not video.get("duration"):
            video["duration"] = ffprobe_duration(Path(video["path"]))
        if args.limit_sec:
            video["duration"] = min(video["duration"], args.limit_sec)

    model = args.model or os.environ.get("DETECT_CLIPS_MODEL") or DEFAULT_MODELS[args.provider]
    args.model = model
    total_sec = sum(v["duration"] for v in videos)
    est_calls = int(total_sec / args.batch)
    print(
        f"Plan: {len(videos)} videos, {total_sec / 60:.1f} min of footage, "
        f"~{int(total_sec)} frames at 1fps, <= {est_calls} API calls "
        f"(batch={args.batch}, buffer={args.buffer}s, "
        f"provider={args.provider}, model={model})"
    )

    client = None
    if not args.dry_run:
        api_key = load_api_key(args.api_key, API_KEY_ENV[args.provider])
        if args.provider == "openai":
            client = OpenAIClient(api_key, model, detail=args.detail)
        else:
            client = GeminiClient(api_key, model)

    all_marks = {}
    all_clips = []
    for video in videos:
        print(f"\n[{video['id']}] {video.get('title', '')[:70]}")
        frames_dir, n_frames = extract_frames(video, args.limit_sec)
        print(f"  frames: {n_frames} in {frames_dir}")
        if args.dry_run:
            continue

        spans, score_events, hype_events, failsafe_events, analyzed = detect_boundaries(
            video, frames_dir, n_frames, client, args
        )
        skipped = n_frames - analyzed
        print(
            f"  clips: {len(spans)}, frames analyzed: {analyzed} "
            f"(buffer skipped ~{max(0, skipped)}), scores seen: {len(score_events)}, "
            f"hype frames: {len(hype_events)}, "
            f"failsafe boundaries: {len(failsafe_events)}"
        )
        all_marks[video["id"]] = {
            "tier": video.get("tier"),
            "boundaries": [s for s, _ in spans],
            "spans": [{"start": s, "end": e} for s, e in spans],
            "scoreEvents": score_events,
            "hypeEvents": hype_events,
            "failsafeBoundaries": failsafe_events,
        }
        hype_ts = [h["t"] for h in hype_events]
        for index, (start, end) in enumerate(spans):
            all_clips.append({
                "videoId": video["id"],
                "video": video,
                "index": index,
                "start": round(start, 3),
                "end": round(end, 3),
                "duration": round(end - start, 3),
                "hypeTs": [t for t in hype_ts if start <= t < end],
            })

    if args.dry_run:
        print("\nDry run: frames extracted, no API calls made.")
        return

    MARKS_PATH.write_text(json.dumps({
        "generatedAt": datetime.datetime.now().astimezone().isoformat(),
        "provider": args.provider,
        "model": model,
        "batch": args.batch,
        "buffer": args.buffer,
        "videos": all_marks,
    }, indent=2) + "\n")
    print(f"\nWrote boundaries to {MARKS_PATH}")
    print(
        f"{args.provider} usage: {client.requests_made} requests, "
        f"{client.prompt_tokens} prompt tokens, {client.output_tokens} output tokens"
    )

    if args.no_cut:
        return

    print(f"\nCutting {len(all_clips)} clips with {args.jobs} jobs…")
    done = 0
    failures = 0
    with ThreadPoolExecutor(max_workers=args.jobs) as pool:
        futures = {
            pool.submit(
                cut_clip, clip["video"], clip["index"], clip["start"], clip["end"],
                args.force,
            ): clip
            for clip in all_clips
        }
        for future in as_completed(futures):
            clip = futures[future]
            try:
                status = future.result()
            except subprocess.CalledProcessError as err:
                failures += 1
                print(f"  FAILED {clip['videoId']} #{clip['index']:03d}: {err}")
                continue
            done += 1
            print(
                f"  [{done}/{len(all_clips)}] {clip['videoId']} "
                f"#{clip['index']:03d} {clip['start']:.0f}-{clip['end']:.0f}s ({status})"
            )

    CLIPS_MANIFEST_PATH.write_text(json.dumps({
        "generatedAt": datetime.datetime.now().astimezone().isoformat(),
        "source": str(MARKS_PATH),
        "clips": [
            {
                "videoId": c["videoId"],
                "index": c["index"],
                "start": c["start"],
                "end": c["end"],
                "duration": c["duration"],
                "hypeTs": c["hypeTs"],
                "path": str(clip_output_path(c["videoId"], c["index"], c["start"], c["end"])),
            }
            for c in all_clips
        ],
    }, indent=2) + "\n")
    print(f"Wrote clip manifest to {CLIPS_MANIFEST_PATH}")
    if failures:
        sys.exit(f"{failures} clip(s) failed to encode")


if __name__ == "__main__":
    main()
