#!/usr/bin/env python3
"""Writes the rendered-program proof composition with official OpenTimelineIO 0.18.1.

    uv run --with opentimelineio==0.18.1 python3 generate-program-fixture.py OUT_DIR [--variant NAME]

Variants:
  positive        supported composition: two video tracks, SMPTE dissolve, 2x time warp,
                  a gap, a 48 kHz chirp track and a 44.1 kHz tone track (resampled by the
                  renderer), and a silent audio gap. Default.
  custom-wipe     the dissolve is a CustomWipe transition. Expected: unsupported-transition.
  unknown-effect  an enabled Blur effect on a clip. Expected: unsupported-effect.
  global-start    the positive composition with global_start_time 3600 s at 24 fps. Renders
                  identically: evaluation is from timeline time 0.

Writes OUT_DIR/content.otio, OUT_DIR/version.txt, and OUT_DIR/library-oracle.json.
The oracle is OpenTimelineIO's own placement of every item. It is not Relic output.
Media files are written by generate-program-media.sh into OUT_DIR/media/.
"""

import argparse
import importlib.metadata
import json
import sys
from pathlib import Path

REQUIRED_OTIO = "0.18.1"
installed = importlib.metadata.version("opentimelineio")
if installed != REQUIRED_OTIO:
    sys.exit(f"opentimelineio {installed} installed; this fixture requires {REQUIRED_OTIO}")

import opentimelineio as otio  # noqa: E402

VIDEO_RATE = 30
AUDIO_RATE = 48000
VARIANTS = ("positive", "custom-wipe", "unknown-effect", "global-start")


def rational(seconds, rate):
    return otio.opentime.RationalTime(round(seconds * rate), rate)


def time_range(start_seconds, duration_seconds, rate):
    return otio.opentime.TimeRange(rational(start_seconds, rate), rational(duration_seconds, rate))


def media(name, available_seconds, rate):
    return otio.schema.ExternalReference(
        target_url=f"media/{name}",
        available_range=time_range(0, available_seconds, rate),
    )


def clip(name, ref, start_seconds, duration_seconds, rate):
    return otio.schema.Clip(
        name=name,
        media_reference=ref,
        source_range=time_range(start_seconds, duration_seconds, rate),
    )


def gap(duration_seconds, rate):
    return otio.schema.Gap(source_range=time_range(0, duration_seconds, rate))


def build(variant):
    transition_type = "CustomWipe" if variant == "custom-wipe" else "SMPTE_Dissolve"
    tone_name, tone_rate = ("tone441.wav", 44100)

    # V1 (bottom video track): plate_a, a 0.4 s dissolve centred on the 3.0 s cut, then plate_b.
    # plate_a has 0.2 s of handle past 3.0 s; plate_b starts 0.2 s before source 2.0 s.
    plate_a = clip("plate_a", media("plate_a.mp4", 4.0, VIDEO_RATE), 0.0, 3.0, VIDEO_RATE)
    plate_b = clip("plate_b", media("plate_b.mp4", 6.0, VIDEO_RATE), 2.0, 3.0, VIDEO_RATE)
    dissolve = otio.schema.Transition(
        name="dissolve",
        transition_type=transition_type,
        in_offset=rational(0.2, VIDEO_RATE),
        out_offset=rational(0.2, VIDEO_RATE),
    )
    v1 = otio.schema.Track(name="V1", kind="Video")
    v1.append(plate_a)
    v1.append(dissolve)
    v1.append(plate_b)

    # V2 (top video track): an opaque plate_c over [1, 2) s, a 2x retime over [4, 5) s.
    plate_c = clip("plate_c", media("plate_c.mp4", 3.0, VIDEO_RATE), 0.0, 1.0, VIDEO_RATE)
    retimed = clip("plate_c_2x", media("plate_c.mp4", 3.0, VIDEO_RATE), 0.0, 1.0, VIDEO_RATE)
    retimed.effects.append(otio.schema.LinearTimeWarp(name="2x", time_scalar=2.0))
    if variant == "unknown-effect":
        plate_c.effects.append(otio.schema.Effect(name="blur", effect_name="Blur"))
    v2 = otio.schema.Track(name="V2", kind="Video")
    v2.append(gap(1.0, VIDEO_RATE))
    v2.append(plate_c)
    v2.append(gap(2.0, VIDEO_RATE))
    v2.append(retimed)
    v2.append(gap(1.0, VIDEO_RATE))

    # A1 (48 kHz): a chirp over [0, 4.5) s, a silent gap over [4.5, 5.0) s, then the chirp again
    # from source 4.5 s over [5, 6) s, so the timeline skips source audio across the gap.
    a1 = otio.schema.Track(name="A1", kind="Audio")
    a1.append(clip("chirp_a", media("chirp48.wav", 6.0, AUDIO_RATE), 0.0, 4.5, AUDIO_RATE))
    a1.append(gap(0.5, AUDIO_RATE))
    a1.append(clip("chirp_b", media("chirp48.wav", 6.0, AUDIO_RATE), 4.5, 1.0, AUDIO_RATE))

    # A2: a tone over [1, 3) s at 44.1 kHz. The renderer resamples it to 48 kHz; the reference is analytic.
    a2 = otio.schema.Track(name="A2", kind="Audio")
    a2.append(gap(1.0, tone_rate))
    a2.append(clip("tone", media(tone_name, 2.0, tone_rate), 0.0, 2.0, tone_rate))
    a2.append(gap(3.0, tone_rate))

    stack = otio.schema.Stack(name="tracks")
    for track in (v1, v2, a1, a2):
        stack.append(track)
    timeline = otio.schema.Timeline(name="Rendered program proof")
    timeline.tracks = stack
    return timeline


def oracle(timeline):
    """Placement of every stack child as OpenTimelineIO reports it. Relic output is never read here."""
    tracks = []
    for track in timeline.tracks:
        children = []
        for index, child in enumerate(track):
            entry = {"index": index, "schema": child.schema_name(), "name": child.name}
            try:
                if isinstance(child, otio.schema.Transition):
                    entry["in_offset"] = [child.in_offset.value, child.in_offset.rate]
                    entry["out_offset"] = [child.out_offset.value, child.out_offset.rate]
                else:
                    rng = track.range_of_child_at_index(index)
                    entry["start"] = [rng.start_time.value, rng.start_time.rate]
                    entry["duration"] = [rng.duration.value, rng.duration.rate]
            except Exception as exc:  # recorded, not hidden: the test fails on any error entry
                entry["error"] = f"{type(exc).__name__}: {exc}"
            children.append(entry)
        tracks.append({"name": track.name, "kind": track.kind, "children": children})
    duration = timeline.duration()
    return {
        "otio_version": importlib.metadata.version("opentimelineio"),
        "duration": [duration.value, duration.rate],
        "tracks": tracks,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("out_dir")
    parser.add_argument("--variant", choices=VARIANTS, default="positive")
    parser.add_argument("--oracle-out", required=True)
    args = parser.parse_args()
    out = Path(args.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    timeline = build(args.variant)
    if args.variant == "global-start":
        # A non-zero origin: 3600 s at 24 fps. The renderer must evaluate from timeline time 0 anyway.
        timeline.global_start_time = otio.opentime.RationalTime(86400, 24)
    otio.adapters.write_to_file(timeline, str(out / "content.otio"), adapter_name="otio_json")
    (out / "version.txt").write_text("1.0.0\n", encoding="utf-8")
    import hashlib
    oracle_doc = oracle(timeline)
    oracle_doc["content_sha256"] = hashlib.sha256((out / "content.otio").read_bytes()).hexdigest()
    Path(args.oracle_out).write_text(json.dumps(oracle_doc, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
