#!/usr/bin/env python3
"""
Generate reproducible OTIO v0.18.1 oracle fixtures and expected evaluation ranges.

This script uses the official Python OpenTimelineIO library (pinned to opentimelineio==0.18.1)
to construct canonical OTIO timelines, serialize them to standard .otio and .otiod formats,
and evaluate exact source ranges, transformed coordinates, active layers, and source spans.

Prerequisites:
    uv run --with opentimelineio==0.18.1 python3 scripts/generate-otio-fixtures.py
or:
    pip install opentimelineio==0.18.1
    python3 scripts/generate-otio-fixtures.py
"""

import json
import math
import os
import sys
from pathlib import Path

try:
    import opentimelineio as otio
    from opentimelineio.opentime import RationalTime, TimeRange
    from opentimelineio.schema import (
        Clip,
        Effect,
        ExternalReference,
        FreezeFrame,
        Gap,
        ImageSequenceReference,
        LinearTimeWarp,
        Marker,
        MarkerColor,
        MissingReference,
        Stack,
        Timeline,
        Track,
        TrackKind,
        Transition,
        TransitionTypes,
    )
except ImportError:
    print("Error: opentimelineio is required. Run with:", file=sys.stderr)
    print("  uv run --with opentimelineio==0.18.1 python3 " + __file__, file=sys.stderr)
    sys.exit(1)


def rt_to_dict(rt: RationalTime) -> dict:
    return {"value": float(rt.value), "rate": float(rt.rate)}


def tr_to_dict(tr: TimeRange) -> dict:
    return {
        "start_time": rt_to_dict(tr.start_time),
        "duration": rt_to_dict(tr.duration),
    }


def file_relative_time(source_time: RationalTime, available_range: TimeRange | None) -> dict:
    if available_range is None:
        return rt_to_dict(source_time)
    avail_start = available_range.start_time
    if source_time.rate != avail_start.rate:
        avail_start = avail_start.rescaled_to(source_time.rate)
    rel_val = source_time.value - avail_start.value
    return {"value": float(rel_val), "rate": float(source_time.rate)}


# -----------------------------------------------------------------------------
# Fixture 1: Standard Sample (.otiod)
# -----------------------------------------------------------------------------
def build_standard_sample_timeline() -> Timeline:
    tl = Timeline(name="Relik Feature Editorial")
    tl.global_start_time = RationalTime(86400, 24)  # 01:00:00:00

    # Video 1: Main base visual track
    v1 = Track(name="Video 1", kind=TrackKind.Video)
    v1.metadata["relic"] = {"id": "track-v1-main"}

    # Clip 1: Primary Grade A (frames 0 to 72 on track)
    c1 = Clip(name="Primary Grade A")
    c1.metadata["relic"] = {"id": "clip-v1-primary-a"}
    c1.source_range = TimeRange(RationalTime(48, 24), RationalTime(72, 24))
    c1.media_reference = ExternalReference(
        target_url="media/primary_a.mp4",
        available_range=TimeRange(RationalTime(24, 24), RationalTime(144, 24)),
    )
    m1 = Marker(
        name="Grade Correction Required",
        marked_range=TimeRange(RationalTime(36, 24), RationalTime(0, 24)),
        color=MarkerColor.RED,
        comment="Clipping in highlights around actor edge",
    )
    m1.metadata["relic"] = {"id": "marker-v1-c1-red"}
    c1.markers.append(m1)

    # Transition 1: SMPTE Dissolve (in 12, out 12, cut at 72)
    tr1 = Transition(
        name="SMPTE_Dissolve_1",
        transition_type=TransitionTypes.SMPTE_Dissolve,
        in_offset=RationalTime(12, 24),
        out_offset=RationalTime(12, 24),
    )
    tr1.metadata["relic"] = {"id": "trans-v1-dissolve-1"}

    # Clip 2: Secondary Grade B (frames 72 to 168 on track)
    c2 = Clip(name="Secondary Grade B")
    c2.metadata["relic"] = {"id": "clip-v1-secondary-b"}
    c2.source_range = TimeRange(RationalTime(24, 24), RationalTime(96, 24))
    ref_proxy = ExternalReference(
        target_url="media/secondary_b.mp4",
        available_range=TimeRange(RationalTime(0, 24), RationalTime(144, 24)),
    )
    ref_orig = ExternalReference(
        target_url="media/secondary_b_prores.mov",
        available_range=TimeRange(RationalTime(0, 24), RationalTime(144, 24)),
    )
    c2.set_media_references({"proxy": ref_proxy, "original": ref_orig}, "proxy")
    m2 = Marker(
        name="VFX Temp Plate Range",
        marked_range=TimeRange(RationalTime(48, 24), RationalTime(24, 24)),
        color=MarkerColor.MAGENTA,
        comment="Replace with final 4K composite plate",
    )
    m2.metadata["relic"] = {"id": "marker-v1-c2-magenta"}
    c2.markers.append(m2)

    # Gap 1: Slug V1 (frames 168 to 192 on track)
    gap1 = Gap(
        name="Slug V1",
        source_range=TimeRange(RationalTime(0, 24), RationalTime(24, 24)),
    )
    gap1.metadata["relic"] = {"id": "gap-v1-slug"}

    # Clip 3: Nested Submaster Compound Clip wrapping a Stack (frames 192 to 240)
    nested_stack = Stack(name="VFX Submaster Stack")
    nested_stack.metadata["relic"] = {"id": "stack-vfx-submaster"}
    nested_stack.source_range = TimeRange(RationalTime(0, 24), RationalTime(48, 24))

    nested_v1 = Track(name="Plate Base", kind=TrackKind.Video)
    nested_v1.metadata["relic"] = {"id": "track-nested-plate-base"}
    nested_c1 = Clip(name="Background CG Plate")
    nested_c1.metadata["relic"] = {"id": "clip-nested-plate"}
    nested_c1.source_range = TimeRange(RationalTime(0, 24), RationalTime(48, 24))
    nested_c1.media_reference = ImageSequenceReference(
        target_url_base="media/vfx_plates/",
        name_prefix="plate_",
        name_suffix=".png",
        start_frame=1001,
        frame_step=1,
        rate=24.0,
        frame_zero_padding=4,
        missing_frame_policy=ImageSequenceReference.MissingFramePolicy.hold,
    )
    nested_v1.append(nested_c1)

    nested_v2 = Track(name="FX Glow", kind=TrackKind.Video)
    nested_v2.metadata["relic"] = {"id": "track-nested-fx-glow"}
    nested_c2 = Clip(name="Energy Flare CG")
    nested_c2.metadata["relic"] = {"id": "clip-nested-flare"}
    nested_c2.source_range = TimeRange(RationalTime(0, 24), RationalTime(48, 24))
    nested_c2.media_reference = ExternalReference(target_url="media/fx_flare.webm")
    nested_v2.append(nested_c2)

    nested_stack.extend([nested_v1, nested_v2])

    v1.extend([c1, tr1, c2, gap1, nested_stack])

    # Video 2: Secondary / effects track
    v2 = Track(name="Video 2", kind=TrackKind.Video)
    v2.metadata["relic"] = {"id": "track-v2-main"}

    # Mixed-rate Clip (30fps in 24fps timeline, frames 0 to 48)
    c_pip = Clip(name="Picture-in-Picture Alpha")
    c_pip.metadata["relic"] = {"id": "clip-v2-pip-alpha"}
    c_pip.source_range = TimeRange(RationalTime(0, 30), RationalTime(60, 30))
    c_pip.media_reference = ExternalReference(
        target_url="media/overlay_alpha.webm",
        available_range=TimeRange(RationalTime(0, 30), RationalTime(150, 30)),
    )

    # LinearTimeWarp (frames 48 to 96)
    c_tw = Clip(name="Speed Ramp Action")
    c_tw.metadata["relic"] = {"id": "clip-v2-timewarp"}
    c_tw.source_range = TimeRange(RationalTime(0, 24), RationalTime(48, 24))
    c_tw.media_reference = ExternalReference(
        target_url="media/primary_a.mp4",
        available_range=TimeRange(RationalTime(24, 24), RationalTime(144, 24)),
    )
    c_tw.effects.append(LinearTimeWarp(name="SpeedUp", time_scalar=2.0))

    # FreezeFrame (frames 96 to 144)
    c_freeze = Clip(name="Hero Freeze Frame")
    c_freeze.metadata["relic"] = {"id": "clip-v2-freeze"}
    c_freeze.source_range = TimeRange(RationalTime(0, 24), RationalTime(48, 24))
    c_freeze.media_reference = ExternalReference(
        target_url="media/secondary_b.mp4",
        available_range=TimeRange(RationalTime(0, 24), RationalTime(144, 24)),
    )
    c_freeze.effects.append(FreezeFrame(name="Freeze"))

    # Unsupported effect (frames 144 to 192)
    c_unsup = Clip(name="Grade Custom Look")
    c_unsup.metadata["relic"] = {"id": "clip-v2-unsupported"}
    c_unsup.source_range = TimeRange(RationalTime(0, 24), RationalTime(48, 24))
    c_unsup.media_reference = ExternalReference(
        target_url="media/primary_a.mp4",
        available_range=TimeRange(RationalTime(24, 24), RationalTime(144, 24)),
    )
    c_unsup.effects.append(Effect(name="CustomLook", effect_name="MagicBulletLook"))

    gap_v2 = Gap(source_range=TimeRange(RationalTime(0, 24), RationalTime(48, 24)))
    gap_v2.metadata["relic"] = {"id": "gap-v2-end"}

    v2.extend([c_pip, c_tw, c_freeze, c_unsup, gap_v2])

    # Video 3: Duplicate track name "Video 2"
    v3 = Track(name="Video 2", kind=TrackKind.Video)
    v3.metadata["relic"] = {"id": "track-v2-duplicate"}
    v3.append(Gap(source_range=TimeRange(RationalTime(0, 24), RationalTime(240, 24))))

    # Audio 1: Dialogue DX (48000Hz)
    a1 = Track(name="Dialogue DX", kind=TrackKind.Audio)
    a1.metadata["relic"] = {"id": "track-a1-main"}
    c_a1 = Clip(name="Interview Mic 1")
    c_a1.metadata["relic"] = {"id": "clip-a1-interview"}
    c_a1.source_range = TimeRange(RationalTime(0, 48000), RationalTime(480000, 48000))
    c_a1.media_reference = ExternalReference(
        target_url="media/dx_mic1.wav",
        available_range=TimeRange(RationalTime(0, 48000), RationalTime(480000, 48000)),
    )
    m_audio = Marker(
        name="Audio Pop",
        marked_range=TimeRange(RationalTime(360000, 48000), RationalTime(0, 48000)),
        color=MarkerColor.YELLOW,
        comment="Check boom mic cable crackle",
    )
    m_audio.metadata["relic"] = {"id": "marker-a1-pop-yellow"}
    c_a1.markers.append(m_audio)
    a1.append(c_a1)

    # Audio 2: Music MX (48000Hz)
    a2 = Track(name="Music MX", kind=TrackKind.Audio)
    a2.metadata["relic"] = {"id": "track-a2-main"}
    gap_a2 = Gap(source_range=TimeRange(RationalTime(0, 48000), RationalTime(96000, 48000)))
    c_a2 = Clip(name="Orchestral Bed")
    c_a2.metadata["relic"] = {"id": "clip-a2-bed"}
    c_a2.source_range = TimeRange(RationalTime(0, 48000), RationalTime(384000, 48000))
    c_a2.media_reference = ExternalReference(
        target_url="media/mx_bed.wav",
        available_range=TimeRange(RationalTime(0, 48000), RationalTime(384000, 48000)),
    )
    a2.extend([gap_a2, c_a2])

    # Audio 3: Duplicate audio track name
    a3 = Track(name="Dialogue DX", kind=TrackKind.Audio)
    a3.metadata["relic"] = {"id": "track-a3-duplicate"}
    a3.append(Gap(source_range=TimeRange(RationalTime(0, 48000), RationalTime(480000, 48000))))

    tl.tracks.extend([v1, v2, v3, a1, a2, a3])
    return tl


# -----------------------------------------------------------------------------
# Fixture 2: Nested Trims
# -----------------------------------------------------------------------------
def build_nested_trims_timeline() -> Timeline:
    tl = Timeline(name="Nested Trims Conformance")
    v = Track(name="Master Track", kind=TrackKind.Video)
    v.metadata["relic"] = {"id": "track-nested-master"}

    head_clip = Clip(name="Head Clip", source_range=TimeRange(RationalTime(0, 24), RationalTime(24, 24)))
    head_clip.media_reference = ExternalReference(target_url="media/primary_a.mp4")

    # Stack with trimmed source_range starting at nonzero frame 12, duration 48
    s = Stack(name="Inner Stack")
    s.metadata["relic"] = {"id": "stack-inner-trims"}
    s.source_range = TimeRange(RationalTime(12, 24), RationalTime(48, 24))

    inner_t1 = Track(name="Inner Track 1", kind=TrackKind.Video)
    inner_t1.metadata["relic"] = {"id": "track-inner-1"}
    c_in1 = Clip(name="Inner Clip 1", source_range=TimeRange(RationalTime(0, 24), RationalTime(72, 24)))
    c_in1.media_reference = ExternalReference(target_url="media/secondary_b.mp4")
    inner_t1.append(c_in1)

    s.append(inner_t1)

    tail_clip = Clip(name="Tail Clip", source_range=TimeRange(RationalTime(0, 24), RationalTime(24, 24)))
    tail_clip.media_reference = ExternalReference(target_url="media/primary_a.mp4")

    v.extend([head_clip, s, tail_clip])
    tl.tracks.append(v)
    return tl


# -----------------------------------------------------------------------------
# Fixture 3: Mixed Rates (including 30000/1001)
# -----------------------------------------------------------------------------
def build_mixed_rates_timeline() -> Timeline:
    tl = Timeline(name="Mixed Rates Conformance")
    tl.global_start_time = RationalTime(0, 24)

    # 24fps track
    t24 = Track(name="Track 24fps", kind=TrackKind.Video)
    c24 = Clip(name="Clip 24fps", source_range=TimeRange(RationalTime(0, 24), RationalTime(48, 24)))
    c24.media_reference = ExternalReference(target_url="media/primary_a.mp4")
    t24.append(c24)

    # 29.97 NTSC drop/fractional rate: 30000/1001
    t29 = Track(name="Track 29.97fps", kind=TrackKind.Video)
    c29 = Clip(name="Clip 29.97fps", source_range=TimeRange(RationalTime(0, 30000 / 1001), RationalTime(60, 30000 / 1001)))
    c29.media_reference = ExternalReference(target_url="media/secondary_b.mp4")
    t29.append(c29)

    # 30fps track
    t30 = Track(name="Track 30fps", kind=TrackKind.Video)
    c30 = Clip(name="Clip 30fps", source_range=TimeRange(RationalTime(0, 30), RationalTime(60, 30)))
    c30.media_reference = ExternalReference(target_url="media/overlay_alpha.webm")
    t30.append(c30)

    # 48000Hz audio track
    ta = Track(name="Track 48kHz", kind=TrackKind.Audio)
    ca = Clip(name="Clip 48kHz", source_range=TimeRange(RationalTime(0, 48000), RationalTime(96000, 48000)))
    ca.media_reference = ExternalReference(target_url="media/dx_mic1.wav")
    ta.append(ca)

    tl.tracks.extend([t24, t29, t30, ta])
    return tl


# -----------------------------------------------------------------------------
# Fixture 4: Asymmetric Dissolves and Edge Transitions
# -----------------------------------------------------------------------------
def build_asymmetric_dissolves_timeline() -> Timeline:
    tl = Timeline(name="Asymmetric Dissolves Conformance")
    v = Track(name="Video Track", kind=TrackKind.Video)

    # Head transition (fade in from black / transparent)
    tr_head = Transition(
        name="Fade In",
        transition_type=TransitionTypes.SMPTE_Dissolve,
        in_offset=RationalTime(0, 24),
        out_offset=RationalTime(12, 24),
    )

    c1 = Clip(name="Clip Left", source_range=TimeRange(RationalTime(0, 24), RationalTime(72, 24)))
    c1.media_reference = ExternalReference(target_url="media/primary_a.mp4")

    # Asymmetric dissolve (18 frames in, 6 frames out)
    tr_asym = Transition(
        name="Asymmetric Dissolve",
        transition_type=TransitionTypes.SMPTE_Dissolve,
        in_offset=RationalTime(18, 24),
        out_offset=RationalTime(6, 24),
    )

    c2 = Clip(name="Clip Right", source_range=TimeRange(RationalTime(0, 24), RationalTime(72, 24)))
    c2.media_reference = ExternalReference(target_url="media/secondary_b.mp4")

    # Dissolve into gap
    tr_gap = Transition(
        name="Dissolve to Gap",
        transition_type=TransitionTypes.SMPTE_Dissolve,
        in_offset=RationalTime(12, 24),
        out_offset=RationalTime(12, 24),
    )
    g = Gap(source_range=TimeRange(RationalTime(0, 24), RationalTime(24, 24)))

    # Tail edge transition (fade out to black)
    tr_tail = Transition(
        name="Fade Out",
        transition_type=TransitionTypes.SMPTE_Dissolve,
        in_offset=RationalTime(12, 24),
        out_offset=RationalTime(0, 24),
    )

    v.extend([tr_head, c1, tr_asym, c2, tr_gap, g, tr_tail])
    tl.tracks.append(v)
    return tl


# -----------------------------------------------------------------------------
# Fixture 5: Timewarp and FreezeFrame
# -----------------------------------------------------------------------------
def build_timewarp_freeze_timeline() -> Timeline:
    tl = Timeline(name="Timewarp Freeze Conformance")
    v = Track(name="Video Track", kind=TrackKind.Video)

    c_fast = Clip(name="Fast Forward 2x", source_range=TimeRange(RationalTime(0, 24), RationalTime(48, 24)))
    c_fast.media_reference = ExternalReference(target_url="media/primary_a.mp4")
    c_fast.effects.append(LinearTimeWarp(name="FastWarp", time_scalar=2.0))

    c_rev = Clip(name="Reverse Playback", source_range=TimeRange(RationalTime(0, 24), RationalTime(48, 24)))
    c_rev.media_reference = ExternalReference(target_url="media/secondary_b.mp4")
    c_rev.effects.append(LinearTimeWarp(name="ReverseWarp", time_scalar=-1.0))

    c_freeze = Clip(name="Freeze Action", source_range=TimeRange(RationalTime(10, 24), RationalTime(48, 24)))
    c_freeze.media_reference = ExternalReference(target_url="media/primary_a.mp4")
    c_freeze.effects.append(FreezeFrame(name="Freeze"))

    v.extend([c_fast, c_rev, c_freeze])
    tl.tracks.append(v)
    return tl


# -----------------------------------------------------------------------------
# Fixture 6: Image Sequence Reference & Policies
# -----------------------------------------------------------------------------
def build_image_sequence_timeline() -> Timeline:
    tl = Timeline(name="Image Sequence Conformance")
    v = Track(name="Image Sequence Track", kind=TrackKind.Video)

    c_hold = Clip(name="Sequence Hold Missing", source_range=TimeRange(RationalTime(0, 24), RationalTime(24, 24)))
    c_hold.media_reference = ImageSequenceReference(
        target_url_base="media/vfx_plates/",
        name_prefix="plate_",
        name_suffix=".png",
        start_frame=1001,
        frame_step=1,
        rate=24.0,
        frame_zero_padding=4,
        missing_frame_policy=ImageSequenceReference.MissingFramePolicy.hold,
    )

    c_black = Clip(name="Sequence Black Missing", source_range=TimeRange(RationalTime(0, 24), RationalTime(24, 24)))
    c_black.media_reference = ImageSequenceReference(
        target_url_base="media/vfx_plates/",
        name_prefix="plate_",
        name_suffix=".png",
        start_frame=1001,
        frame_step=1,
        rate=24.0,
        frame_zero_padding=4,
        missing_frame_policy=ImageSequenceReference.MissingFramePolicy.black,
    )

    c_err = Clip(name="Sequence Error Missing", source_range=TimeRange(RationalTime(0, 24), RationalTime(24, 24)))
    c_err.media_reference = ImageSequenceReference(
        target_url_base="media/vfx_plates/",
        name_prefix="plate_",
        name_suffix=".png",
        start_frame=1001,
        frame_step=1,
        rate=24.0,
        frame_zero_padding=4,
        missing_frame_policy=ImageSequenceReference.MissingFramePolicy.error,
    )

    v.extend([c_hold, c_black, c_err])
    tl.tracks.append(v)
    return tl


# -----------------------------------------------------------------------------
# Fixture 7: Missing Media, Unsupported Codecs/Effects, 64-bit Int Metadata
# -----------------------------------------------------------------------------
def build_missing_unsupported_timeline() -> Timeline:
    tl = Timeline(name="Missing and Unsupported Conformance")
    tl.metadata["relic"] = {
        "max_int64": 9223372036854775807,
        "min_int64": -9223372036854775808,
        "non_finite_infinity": "Infinity",
        "non_finite_nan": "NaN",
        "unknown_schema_entity": {
            "OTIO_SCHEMA": "UnknownVendorEntity.99",
            "vendor": "AcmePost",
            "token": "preserved-exact-value",
        },
    }

    v = Track(name="Video Track", kind=TrackKind.Video)

    c_missing = Clip(name="Offline Clip", source_range=TimeRange(RationalTime(0, 24), RationalTime(48, 24)))
    c_missing.media_reference = MissingReference()
    c_missing.metadata["relic"] = {"status": "missing-media"}

    c_codec = Clip(name="Unsupported Codec Clip", source_range=TimeRange(RationalTime(0, 24), RationalTime(48, 24)))
    c_codec.media_reference = ExternalReference(target_url="media/prores_4444_xq.mov")
    c_codec.metadata["relic"] = {"status": "unsupported-codec", "codec": "ProRes 4444 XQ"}

    c_effect = Clip(name="Unsupported Effect Clip", source_range=TimeRange(RationalTime(0, 24), RationalTime(48, 24)))
    c_effect.media_reference = ExternalReference(target_url="media/primary_a.mp4")
    c_effect.effects.append(Effect(name="ProprietaryLUT", effect_name="MagicBulletLook"))
    c_effect.metadata["relic"] = {"status": "unsupported-effect"}

    v.extend([c_missing, c_codec, c_effect])
    tl.tracks.append(v)
    return tl


# -----------------------------------------------------------------------------
# Fixture 8: Duplicate Track Names
# -----------------------------------------------------------------------------
def build_duplicate_tracks_timeline() -> Timeline:
    tl = Timeline(name="Duplicate Track Names Conformance")
    t1 = Track(name="Video Track", kind=TrackKind.Video)
    t1.metadata["relic"] = {"id": "track-dup-v1-primary"}
    t1.append(Clip(name="Clip V1", source_range=TimeRange(RationalTime(0, 24), RationalTime(48, 24))))

    t2 = Track(name="Video Track", kind=TrackKind.Video)
    t2.metadata["relic"] = {"id": "track-dup-v2-secondary"}
    t2.append(Clip(name="Clip V2", source_range=TimeRange(RationalTime(0, 24), RationalTime(48, 24))))

    a1 = Track(name="Audio Track", kind=TrackKind.Audio)
    a1.metadata["relic"] = {"id": "track-dup-a1"}
    a1.append(Clip(name="Audio A1", source_range=TimeRange(RationalTime(0, 48000), RationalTime(96000, 48000))))

    a2 = Track(name="Audio Track", kind=TrackKind.Audio)
    a2.metadata["relic"] = {"id": "track-dup-a2"}
    a2.append(Clip(name="Audio A2", source_range=TimeRange(RationalTime(0, 48000), RationalTime(96000, 48000))))

    tl.tracks.extend([t1, t2, a1, a2])
    return tl


# -----------------------------------------------------------------------------
# Expected Oracle Evaluations Generation
# -----------------------------------------------------------------------------
def generate_expected_oracle_data() -> dict:
    """Generate expected evaluations and source spans for standard-sample and edge cases."""
    oracle = {
        "version": 1,
        "generator": {
            "recipe": "uv run --with opentimelineio==0.18.1 python3 scripts/generate-otio-fixtures.py",
            "otio_version": f"opentimelineio=={otio.__version__}",
        },
        "fixtures": {},
    }

    # Standard sample timeline expectations
    tl = build_standard_sample_timeline()
    standard_expected = {
        "timeline_name": tl.name,
        "global_start_time": rt_to_dict(tl.global_start_time),
        "duration": rt_to_dict(tl.duration()),
        "tracks": [
            {
                "id": t.metadata.get("relic", {}).get("id", f"track-{i}"),
                "name": t.name,
                "kind": "Video" if t.kind == TrackKind.Video else "Audio",
                "child_count": len(t),
                "duration": rt_to_dict(t.duration()),
            }
            for i, t in enumerate(tl.tracks)
        ],
        "evaluations_at_time": [
            # t = 0 (Start of timeline)
            {
                "time": {"value": 0.0, "rate": 24.0},
                "video_layers": [
                    {
                        "track_id": "track-v1-main",
                        "clip_id": "clip-v1-primary-a",
                        "media_url": "media/primary_a.mp4",
                        "source_time": {"value": 48.0, "rate": 24.0},
                        "file_relative_time": {"value": 24.0, "rate": 24.0},  # 48 - available_start(24) = 24
                        "weight": 1.0,
                    },
                    {
                        "track_id": "track-v2-main",
                        "clip_id": "clip-v2-pip-alpha",
                        "media_url": "media/overlay_alpha.webm",
                        "source_time": {"value": 0.0, "rate": 30.0},
                        "file_relative_time": {"value": 0.0, "rate": 30.0},
                        "weight": 1.0,
                    },
                ],
                "audio_layers": [
                    {
                        "track_id": "track-a1-main",
                        "clip_id": "clip-a1-interview",
                        "media_url": "media/dx_mic1.wav",
                        "source_time": {"value": 0.0, "rate": 48000.0},
                    }
                ],
            },
            # t = 36 (Inside Clip 1, marker 1 location)
            {
                "time": {"value": 36.0, "rate": 24.0},
                "video_layers": [
                    {
                        "track_id": "track-v1-main",
                        "clip_id": "clip-v1-primary-a",
                        "media_url": "media/primary_a.mp4",
                        "source_time": {"value": 84.0, "rate": 24.0},  # 48 + 36 = 84
                        "file_relative_time": {"value": 60.0, "rate": 24.0},  # 84 - 24 = 60
                        "weight": 1.0,
                    },
                    {
                        "track_id": "track-v2-main",
                        "clip_id": "clip-v2-pip-alpha",
                        "media_url": "media/overlay_alpha.webm",
                        "source_time": {"value": 45.0, "rate": 30.0},  # 36 / 24 * 30 = 45
                        "file_relative_time": {"value": 45.0, "rate": 30.0},
                        "weight": 1.0,
                    },
                ],
                "audio_layers": [
                    {
                        "track_id": "track-a1-main",
                        "clip_id": "clip-a1-interview",
                        "media_url": "media/dx_mic1.wav",
                        "source_time": {"value": 72000.0, "rate": 48000.0},  # 36 / 24 * 48000 = 72000
                    }
                ],
            },
            # t = 66 (Inside SMPTE_Dissolve, in-offset region: cut=72, in=12 -> [60, 84))
            # progress u = (66 - 60) / 24 = 6 / 24 = 0.25
            # weight C1 = 0.75, weight C2 = 0.25
            {
                "time": {"value": 66.0, "rate": 24.0},
                "video_layers": [
                    {
                        "track_id": "track-v1-main",
                        "clip_id": "clip-v1-primary-a",
                        "media_url": "media/primary_a.mp4",
                        "source_time": {"value": 114.0, "rate": 24.0},  # 48 + 66 = 114
                        "file_relative_time": {"value": 90.0, "rate": 24.0},
                        "weight": 0.75,
                    },
                    {
                        "track_id": "track-v1-main",
                        "clip_id": "clip-v1-secondary-b",
                        "media_url": "media/secondary_b.mp4",
                        "source_time": {"value": 18.0, "rate": 24.0},  # cut at 72 has source 24; at 66 source is 24 - 6 = 18
                        "file_relative_time": {"value": 18.0, "rate": 24.0},
                        "weight": 0.25,
                    },
                    {
                        "track_id": "track-v2-main",
                        "clip_id": "clip-v2-timewarp",
                        "media_url": "media/primary_a.mp4",
                        "source_time": {"value": 36.0, "rate": 24.0},  # (66 - 48) * 2.0 = 36
                        "file_relative_time": {"value": 12.0, "rate": 24.0},  # 36 - 24 = 12
                        "weight": 1.0,
                    },
                ],
            },
            # t = 72 (Exact cut point of dissolve, progress u = 12 / 24 = 0.5)
            {
                "time": {"value": 72.0, "rate": 24.0},
                "video_layers": [
                    {
                        "track_id": "track-v1-main",
                        "clip_id": "clip-v1-primary-a",
                        "media_url": "media/primary_a.mp4",
                        "source_time": {"value": 120.0, "rate": 24.0},  # 48 + 72 = 120
                        "file_relative_time": {"value": 96.0, "rate": 24.0},
                        "weight": 0.5,
                    },
                    {
                        "track_id": "track-v1-main",
                        "clip_id": "clip-v1-secondary-b",
                        "media_url": "media/secondary_b.mp4",
                        "source_time": {"value": 24.0, "rate": 24.0},  # start of clip source_range
                        "file_relative_time": {"value": 24.0, "rate": 24.0},
                        "weight": 0.5,
                    },
                ],
            },
            # t = 78 (Out-offset region of dissolve, progress u = (78 - 60) / 24 = 18 / 24 = 0.75)
            # weight C1 = 0.25, weight C2 = 0.75
            {
                "time": {"value": 78.0, "rate": 24.0},
                "video_layers": [
                    {
                        "track_id": "track-v1-main",
                        "clip_id": "clip-v1-primary-a",
                        "media_url": "media/primary_a.mp4",
                        "source_time": {"value": 126.0, "rate": 24.0},  # 48 + 78 = 126 (in tail handle)
                        "file_relative_time": {"value": 102.0, "rate": 24.0},
                        "weight": 0.25,
                    },
                    {
                        "track_id": "track-v1-main",
                        "clip_id": "clip-v1-secondary-b",
                        "media_url": "media/secondary_b.mp4",
                        "source_time": {"value": 30.0, "rate": 24.0},  # 24 + 6 = 30
                        "file_relative_time": {"value": 30.0, "rate": 24.0},
                        "weight": 0.75,
                    },
                ],
            },
            # t = 100 (Secondary Grade B active, Hero Freeze Frame on V2)
            {
                "time": {"value": 100.0, "rate": 24.0},
                "video_layers": [
                    {
                        "track_id": "track-v1-main",
                        "clip_id": "clip-v1-secondary-b",
                        "media_url": "media/secondary_b.mp4",
                        "source_time": {"value": 52.0, "rate": 24.0},  # 24 + (100 - 72) = 52
                        "file_relative_time": {"value": 52.0, "rate": 24.0},
                        "weight": 1.0,
                    },
                    {
                        "track_id": "track-v2-main",
                        "clip_id": "clip-v2-freeze",
                        "media_url": "media/secondary_b.mp4",
                        "source_time": {"value": 0.0, "rate": 24.0},  # Frozen at start frame
                        "file_relative_time": {"value": 0.0, "rate": 24.0},
                        "weight": 1.0,
                    },
                ],
            },
            # t = 180 (Slug Gap on V1, Dialogue and Music on audio)
            {
                "time": {"value": 180.0, "rate": 24.0},
                "video_layers": [],  # Gap on V1, Gap on V2
                "audio_layers": [
                    {
                        "track_id": "track-a1-main",
                        "clip_id": "clip-a1-interview",
                        "media_url": "media/dx_mic1.wav",
                        "source_time": {"value": 360000.0, "rate": 48000.0},
                    },
                    {
                        "track_id": "track-a2-main",
                        "clip_id": "clip-a2-bed",
                        "media_url": "media/mx_bed.wav",
                        "source_time": {"value": 264000.0, "rate": 48000.0},  # (180 - 48) / 24 * 48000 = 132/24 * 48000 = 264000
                    },
                ],
            },
            # t = 200 (Inside Nested Submaster Stack: Image sequence plate + FX glow)
            {
                "time": {"value": 200.0, "rate": 24.0},
                "video_layers": [
                    {
                        "track_id": "track-nested-plate-base",
                        "clip_id": "clip-nested-plate",
                        "media_url": "media/vfx_plates/plate_1009.png",  # start_frame 1001 + (200 - 192) = 1009
                        "source_time": {"value": 8.0, "rate": 24.0},
                        "weight": 1.0,
                    },
                    {
                        "track_id": "track-nested-fx-glow",
                        "clip_id": "clip-nested-flare",
                        "media_url": "media/fx_flare.webm",
                        "source_time": {"value": 8.0, "rate": 24.0},
                        "weight": 1.0,
                    },
                ],
            },
        ],
        "source_spans_queries": [
            {
                "track_id": "track-v1-main",
                "query_range": {"start_time": {"value": 20.0, "rate": 24.0}, "duration": {"value": 30.0, "rate": 24.0}},
                "expected_spans": [
                    {
                        "clip_id": "clip-v1-primary-a",
                        "media_url": "media/primary_a.mp4",
                        "source_range": {"start_time": {"value": 68.0, "rate": 24.0}, "duration": {"value": 30.0, "rate": 24.0}},
                        "file_relative_range": {"start_time": {"value": 44.0, "rate": 24.0}, "duration": {"value": 30.0, "rate": 24.0}},
                    }
                ],
            },
            {
                "track_id": "track-v1-main",
                "query_range": {"start_time": {"value": 60.0, "rate": 24.0}, "duration": {"value": 30.0, "rate": 24.0}},
                "expected_spans": [
                    {
                        "clip_id": "clip-v1-primary-a",
                        "media_url": "media/primary_a.mp4",
                        "source_range": {"start_time": {"value": 108.0, "rate": 24.0}, "duration": {"value": 12.0, "rate": 24.0}},
                        "file_relative_range": {"start_time": {"value": 84.0, "rate": 24.0}, "duration": {"value": 12.0, "rate": 24.0}},
                    },
                    {
                        "clip_id": "clip-v1-secondary-b",
                        "media_url": "media/secondary_b.mp4",
                        "source_range": {"start_time": {"value": 24.0, "rate": 24.0}, "duration": {"value": 18.0, "rate": 24.0}},
                        "file_relative_range": {"start_time": {"value": 24.0, "rate": 24.0}, "duration": {"value": 18.0, "rate": 24.0}},
                    },
                ],
            },
        ],
    }
    oracle["fixtures"]["standard-sample"] = standard_expected

    return oracle


def main():
    root = Path(__file__).resolve().parent.parent
    fixtures_dir = root / "packages" / "relic-format" / "test" / "fixtures" / "otio"
    fixtures_dir.mkdir(parents=True, exist_ok=True)
    edge_cases_dir = fixtures_dir / "edge-cases"
    edge_cases_dir.mkdir(parents=True, exist_ok=True)
    standard_otiod = fixtures_dir / "standard-sample.otiod"
    standard_otiod.mkdir(parents=True, exist_ok=True)

    print("Generating standard-sample.otiod/content.otio...")
    tl_std = build_standard_sample_timeline()
    otio.adapters.write_to_file(tl_std, str(standard_otiod / "content.otio"), "otio_json")

    version_file = standard_otiod / "version.txt"
    version_file.write_text("1.0.0\n")

    print("Generating edge cases...")
    otio.adapters.write_to_file(build_nested_trims_timeline(), str(edge_cases_dir / "nested-trims.otio"), "otio_json")
    otio.adapters.write_to_file(build_mixed_rates_timeline(), str(edge_cases_dir / "mixed-rates.otio"), "otio_json")
    otio.adapters.write_to_file(build_asymmetric_dissolves_timeline(), str(edge_cases_dir / "asymmetric-dissolves.otio"), "otio_json")
    otio.adapters.write_to_file(build_timewarp_freeze_timeline(), str(edge_cases_dir / "timewarp-freeze.otio"), "otio_json")
    otio.adapters.write_to_file(build_image_sequence_timeline(), str(edge_cases_dir / "image-sequence.otio"), "otio_json")
    otio.adapters.write_to_file(build_missing_unsupported_timeline(), str(edge_cases_dir / "missing-unsupported.otio"), "otio_json")
    otio.adapters.write_to_file(build_duplicate_tracks_timeline(), str(edge_cases_dir / "duplicate-tracks.otio"), "otio_json")

    print("Generating expected-oracle.json...")
    oracle_data = generate_expected_oracle_data()
    oracle_file = fixtures_dir / "expected-oracle.json"
    with open(oracle_file, "w") as f:
        json.dump(oracle_data, f, indent=2)
        f.write("\n")

    print("Fixture generation complete.")


if __name__ == "__main__":
    main()
