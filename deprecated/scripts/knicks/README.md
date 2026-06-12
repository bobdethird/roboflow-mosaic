# Knicks Offline Pipeline Notes

## Source Manifest Contract

`01-scrape.mjs` writes `data/sources.json`; `01b-segment.mjs` enriches the same
file with audio-first clip boundaries. The downstream `02-index.mjs` consumes
this shape:

```json
{
  "profile": "prototype",
  "target": {
    "candidatePool": 1000,
    "safetyMargin": 1.5,
    "projectedCandidatePool": 1500
  },
  "videos": [
    {
      "id": "youtubeId",
      "title": "Video title",
      "url": "https://www.youtube.com/watch?v=youtubeId",
      "tier": "hero | filler | fan",
      "source": "hero | fan-url | channel/search locator",
      "path": "scripts/knicks/data/videos/youtubeId.mp4",
      "infoJson": "scripts/knicks/data/metadata/youtubeId.json",
      "duration": 482,
      "durationSec": 482,
      "height": 1080,
      "fps": 30,
      "chapters": [],
      "segments": [
        {
          "start": 120.5,
          "end": 137.5,
          "keyT": 134.0,
          "sceneScore": null,
          "loudnessDb": -8.42,
          "source": "audio | fixed"
        }
      ],
      "projectedWindows": 24
    }
  ]
}
```

## Segmentation Policy

Hero videos prefer YouTube chapters: candidate key frames are sampled near each
chapter end. If a hero source has no chapters, it falls back to `segments[]`,
then fixed-interval sampling.

Filler and fan videos prefer `segments[].keyT`. Segments are audio-first:
`silenceNoiseDb`, `silenceMinDur`, `loudnessStepDb`, and `envelopeWindowSec`
control silence gaps and volume-step boundaries. `keyFrameMode: "loudnessPeak"`
places the key frame at the loudest moment within the segment. Visual scene cuts
remain behind `useSceneCuts: false` because in-play camera cuts over-segment.

`03-match.mjs` lets fan-tagged candidates compete everywhere, including the
opening crop, while hero candidates still provide the core chaptered source pool.
