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
    # Source 36 is before source_range start 48. Official transformed_time_range
    # maps it to parent -12. The in-trim marker below is the one active at playback 36.
    m_in = Marker(
        name="In Trim Note",
        marked_range=TimeRange(RationalTime(84, 24), RationalTime(0, 24)),
        color=MarkerColor.GREEN,
        comment="Inside the trimmed source range",
    )
    m_in.metadata["relic"] = {"id": "marker-v1-c1-in-trim"}
    c1.markers.append(m_in)

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
        available_range=TimeRange(RationalTime(0, 24), RationalTime(24, 24)),
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
    m_gap = Marker(
        name="Gap Marker",
        marked_range=TimeRange(RationalTime(6, 24), RationalTime(0, 24)),
        color=MarkerColor.YELLOW,
        comment="Point inside the gap",
    )
    m_gap.metadata["relic"] = {"id": "marker-gap-v1"}
    gap1.markers.append(m_gap)

    # Clip 3: Nested Submaster Compound Clip wrapping a Stack (frames 192 to 240)
    nested_stack = Stack(name="VFX Submaster Stack")
    nested_stack.metadata["relic"] = {"id": "stack-vfx-submaster"}
    nested_stack.source_range = TimeRange(RationalTime(0, 24), RationalTime(48, 24))
    m_stack = Marker(
        name="Stack Marker",
        marked_range=TimeRange(RationalTime(8, 24), RationalTime(0, 24)),
        color=MarkerColor.BLUE,
        comment="Point inside the stack source range",
    )
    m_stack.metadata["relic"] = {"id": "marker-stack-local"}
    nested_stack.markers.append(m_stack)

    nested_v1 = Track(name="Plate Base", kind=TrackKind.Video)
    nested_v1.metadata["relic"] = {"id": "track-nested-plate-base"}
    nested_c1 = Clip(name="Background CG Plate")
    nested_c1.metadata["relic"] = {"id": "clip-nested-plate"}
    nested_c1.source_range = TimeRange(RationalTime(0, 24), RationalTime(48, 24))
    nested_c1.media_reference = ImageSequenceReference(
        target_url_base="media/",
        name_prefix="plate_",
        name_suffix=".png",
        start_frame=1001,
        frame_step=1,
        rate=24.0,
        frame_zero_padding=4,
        missing_frame_policy=ImageSequenceReference.MissingFramePolicy.hold,
        available_range=TimeRange(RationalTime(0, 24), RationalTime(48, 24)),
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

    m_track = Marker(
        name="Track Marker",
        marked_range=TimeRange(RationalTime(100, 24), RationalTime(0, 24)),
        color=MarkerColor.BLUE,
        comment="Point in track time",
    )
    m_track.metadata["relic"] = {"id": "marker-v1-track"}
    v1.markers.append(m_track)
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
    disabled = Clip(
        name="Disabled Duplicate Picture",
        source_range=TimeRange(RationalTime(0, 24), RationalTime(48, 24)),
    )
    disabled.enabled = False
    disabled.metadata["relic"] = {"id": "clip-v2-duplicate-disabled", "status": "disabled"}
    disabled.media_reference = ExternalReference(
        target_url="media/primary_a.mp4",
        available_range=TimeRange(RationalTime(24, 24), RationalTime(144, 24)),
    )
    gap_disabled = Gap(source_range=TimeRange(RationalTime(0, 24), RationalTime(192, 24)))
    gap_disabled.metadata["relic"] = {"id": "gap-v2-duplicate-rest"}
    v3.extend([disabled, gap_disabled])

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
def _seq(name, prefix, start_frame, step, policy, frames, base, rate=24.0):
    clip = Clip(name=name, source_range=TimeRange(RationalTime(0, rate), RationalTime(frames, rate)))
    clip.metadata["relic"] = {"id": "clip-" + name.lower().replace(" ", "-")}
    clip.media_reference = ImageSequenceReference(
        target_url_base=base,
        name_prefix=prefix,
        name_suffix=".png",
        start_frame=start_frame,
        frame_step=step,
        rate=rate,
        frame_zero_padding=4,
        missing_frame_policy=policy,
        available_range=TimeRange(RationalTime(0, rate), RationalTime(frames, rate)),
    )
    return clip


def build_image_sequence_timeline() -> Timeline:
    tl = Timeline(name="Image Sequence Conformance")
    policies = Track(name="Policies", kind=TrackKind.Video)
    policies.metadata["relic"] = {"id": "track-image-policies"}
    # Source is longer than available media so a later sample is outside available_range.
    # The library does not apply hold/black/error; it reports the time invalid. Relik policy is separate.
    for name, policy in (
        ("Sequence Hold Missing", ImageSequenceReference.MissingFramePolicy.hold),
        ("Sequence Black Missing", ImageSequenceReference.MissingFramePolicy.black),
        ("Sequence Error Missing", ImageSequenceReference.MissingFramePolicy.error),
    ):
        clip = Clip(name=name, source_range=TimeRange(RationalTime(0, 24), RationalTime(8, 24)))
        clip.metadata["relic"] = {"id": "clip-" + name.lower().replace(" ", "-")}
        clip.media_reference = ImageSequenceReference(
            target_url_base="media/",
            name_prefix="plate_",
            name_suffix=".png",
            start_frame=1001,
            frame_step=1,
            rate=24.0,
            frame_zero_padding=4,
            missing_frame_policy=policy,
            available_range=TimeRange(RationalTime(0, 24), RationalTime(4, 24)),
        )
        policies.append(clip)

    step = Track(name="Step Two", kind=TrackKind.Video)
    step.metadata["relic"] = {"id": "track-image-step"}
    step.append(_seq(
        "Sequence Step Two",
        "step_",
        0,
        2,
        ImageSequenceReference.MissingFramePolicy.error,
        8,
        "media",
    ))

    signed = Track(name="Signed Start", kind=TrackKind.Video)
    signed.metadata["relic"] = {"id": "track-image-signed"}
    signed.append(_seq(
        "Sequence Signed Start",
        "signed_",
        -3,
        1,
        ImageSequenceReference.MissingFramePolicy.error,
        4,
        "media/",
    ))
    tl.tracks.extend([policies, step, signed])
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
    c_codec.media_reference = ExternalReference(target_url="media/unsupported_prores.mov")
    c_codec.metadata["relic"] = {
        "status": "unsupported-codec",
        "codec": "prores",
        "note": "Profile is whatever ffprobe records in media-measured.json. The filename is not a profile claim.",
    }

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
# Fixture 9: Decoder timing boundary media
# -----------------------------------------------------------------------------
def build_decoder_boundary_timeline() -> Timeline:
    """Stable archive shell for the independently ffprobe-derived media proof."""
    tl = Timeline(name="Decoder Timing Boundary")
    track = Track(name="Actual Packet Timing", kind=TrackKind.Video)
    track.metadata["relic"] = {"id": "track-decoder-boundary"}

    def clip(
        identifier,
        name,
        target,
        source_start,
        source_duration,
        available_start,
        available_duration,
    ):
        node = Clip(
            name=name,
            source_range=TimeRange(
                RationalTime(*source_start), RationalTime(*source_duration)
            ),
            media_reference=ExternalReference(
                target_url=target,
                available_range=TimeRange(
                    RationalTime(*available_start), RationalTime(*available_duration)
                ),
            ),
        )
        node.metadata["relic"] = {"id": identifier}
        return node

    r2997 = 30000 / 1001
    track.extend(
        [
            clip(
                "decoder-mp4-24",
                "24fps MP4",
                "media/fr24.mp4",
                (0, 24),
                (48, 24),
                (0, 24),
                (48, 24),
            ),
            clip(
                "decoder-mp4-60",
                "60fps MP4 through 24-rate source",
                "media/fr60.mp4",
                (0, 24),
                (48, 24),
                (0, 60),
                (120, 60),
            ),
            clip(
                "decoder-rate-one",
                "Rate-one source",
                "media/fr24.mp4",
                (0, 1),
                (2, 1),
                (0, 1),
                (2, 1),
            ),
            clip(
                "decoder-mixed-rate",
                "29.97-rate source",
                "media/fr24.mp4",
                (0, r2997),
                (60000 / 1001, r2997),
                (0, r2997),
                (60000 / 1001, r2997),
            ),
            clip(
                "decoder-bframe-mp4",
                "B-frame MP4",
                "media/fr24b.mp4",
                (0, 24),
                (48, 24),
                (0, 24),
                (48, 24),
            ),
            clip(
                "decoder-bframe-mov",
                "B-frame MOV",
                "media/fr24b.mov",
                (0, 24),
                (48, 24),
                (0, 24),
                (48, 24),
            ),
            clip(
                "decoder-vfr",
                "VFR MP4",
                "media/vfr.mp4",
                (0, 24),
                (47, 24),
                (0, 24),
                (47, 24),
            ),
            clip(
                "decoder-webm",
                "Quantized WebM",
                "media/fr30.webm",
                (0, 30),
                (90, 30),
                (0, 30),
                (90, 30),
            ),
        ]
    )
    tl.tracks.append(track)
    return tl



# -----------------------------------------------------------------------------
# Oracle: official library ranges, plus a labeled Relik rendering contract
# -----------------------------------------------------------------------------
REQUIRED_OTIO_VERSION = "0.18.1"

# Sample times and queries are inputs, not answers. Answers come from the library.
STANDARD_TIMES = (0, 36, 60, 66, 72, 78, 84, 100, 160, 174, 180, 192, 200)
STANDARD_QUERIES = (
    ("track-v1-main", 20, 30),
    ("track-v1-main", 60, 30),
    ("track-v2-main", 48, 48),
    ("track-a1-main", 0, 24),
)
NESTED_TIMES = (0, 12, 24, 36, 71, 72)
NESTED_QUERIES = (("track-nested-master", 24, 48), ("track-nested-master", 12, 72))
MIXED_TIMES = (0, 24)
ASYM_TIMES = (0, 6, 11, 54, 72, 132, 144, 156, 167)
ASYM_QUERIES = (("track-asymmetric", 0, 12), ("track-asymmetric", 54, 24), ("track-asymmetric", 156, 12))
WARP_TIMES = (0, 1, 47, 48, 72, 96)
IMAGE_TIMES = (0, 1, 2, 5)
MISSING_TIMES = (0, 48, 96)
DUP_TIMES = (0,)


def assert_library_version() -> str:
    version = getattr(otio, "__version__", None)
    if version != REQUIRED_OTIO_VERSION:
        raise SystemExit(
            f"opentimelineio {version!r} != required {REQUIRED_OTIO_VERSION}. "
            "Run: uv run --with opentimelineio==0.18.1 python3 scripts/generate-otio-fixtures.py"
        )
    return version


def rt_dict(value):
    if value is None:
        return None
    return {"value": value.value, "rate": value.rate}


def tr_dict(value):
    if value is None:
        return None
    return {
        "start_time": rt_dict(value.start_time),
        "duration": rt_dict(value.duration),
        "end_time_exclusive": rt_dict(value.end_time_exclusive()),
    }


def call(fn):
    try:
        return fn(), None
    except Exception as exc:
        return None, {"error": type(exc).__name__, "message": str(exc)}


def read_range(obj, name):
    attr = getattr(obj, name, None)
    if attr is None:
        return None, {"error": "missing", "message": name}
    if callable(attr):
        return call(attr)
    return attr, None


def relic_id(item, fallback):
    # OTIO metadata values are AnyDictionary, not dict. Do not isinstance-check them.
    try:
        meta = item.metadata["relic"]
        value = meta["id"]
    except Exception:
        return fallback
    return value or fallback


def kind_name(track):
    if track.kind == TrackKind.Video:
        return "Video"
    if track.kind == TrackKind.Audio:
        return "Audio"
    return str(track.kind)


def library_ranges(item, parent):
    record = {}
    for name in ("trimmed_range", "visible_range", "available_range", "range_in_parent", "trimmed_range_in_parent"):
        fn = getattr(item, name, None)
        if fn is None:
            record[name] = None
            record[name + "_error"] = "not_on_this_schema"
            continue
        value, err = call(fn)
        record[name] = tr_dict(value)
        if err:
            record[name + "_error"] = err
    if parent is not None and hasattr(parent, "handles_of_child") and not isinstance(item, otio.schema.Transition):
        handles, err = call(lambda: parent.handles_of_child(item))
        if err:
            record["handles_of_child"] = None
            record["handles_of_child_error"] = err
        else:
            record["handles_of_child"] = [rt_dict(part) for part in handles]
        for name in ("range_of_child", "trimmed_range_of_child"):
            value, err = call(lambda name=name: getattr(parent, name)(item))
            record[name] = tr_dict(value)
            if err:
                record[name + "_error"] = err
    if isinstance(item, otio.schema.Transition):
        record["in_offset"] = rt_dict(item.in_offset)
        record["out_offset"] = rt_dict(item.out_offset)
        record["transition_type"] = item.transition_type
        value, err = call(item.range_in_parent)
        record["range_in_parent"] = tr_dict(value)
        if err:
            record["range_in_parent_error"] = err
    return record


def visible_parent_range(parent, child):
    """range_of_child extended by handles_of_child. Not a second timing model."""
    if isinstance(child, otio.schema.Transition):
        return child.range_in_parent()
    base = parent.range_of_child(child)
    pre, post = parent.handles_of_child(child)
    start = base.start_time
    end = base.end_time_exclusive()
    if pre is not None:
        start = start - pre.rescaled_to(start.rate)
    if post is not None:
        end = end + post.rescaled_to(end.rate)
    if not (end > start):
        return base
    return TimeRange.range_from_start_end_time(start, end)


def intersect_ranges(left, right):
    if left is None or right is None or not left.intersects(right):
        return None
    start = left.start_time if left.start_time >= right.start_time else right.start_time
    left_end = left.end_time_exclusive()
    right_end = right.end_time_exclusive()
    end = left_end if left_end <= right_end else right_end
    if not (end > start):
        return None
    return TimeRange.range_from_start_end_time(start, end)


def active_reference(item):
    key = getattr(item, "active_media_reference_key", None)
    refs = {}
    if hasattr(item, "media_references"):
        try:
            refs = dict(item.media_references())
        except Exception:
            refs = {}
    if key and key in refs:
        return key, refs[key], refs
    ref = getattr(item, "media_reference", None)
    return key, ref, refs


def reference_record(ref):
    if ref is None:
        return None
    record = {"schema": f"{ref.schema_name()}.{ref.schema_version()}"}
    if isinstance(ref, ImageSequenceReference):
        record["target_url_base"] = ref.target_url_base
        record["name_prefix"] = ref.name_prefix
        record["name_suffix"] = ref.name_suffix
        record["start_frame"] = ref.start_frame
        record["frame_step"] = ref.frame_step
        record["rate"] = ref.rate
        record["frame_zero_padding"] = ref.frame_zero_padding
        record["missing_frame_policy"] = str(ref.missing_frame_policy).split(".")[-1]
        avail, err = read_range(ref, "available_range")
        record["available_range"] = tr_dict(avail)
        if err:
            record["available_range_error"] = err
        count, err = call(ref.number_of_images_in_sequence)
        record["number_of_images_in_sequence"] = count
        if err:
            record["number_of_images_error"] = err
        urls = []
        if count:
            for index in range(count):
                url, url_err = call(lambda index=index: ref.target_url_for_image_number(index))
                presented, pres_err = call(lambda index=index: ref.presentation_time_for_image_number(index))
                urls.append({
                    "image_index": index,
                    "target_url": url,
                    "presentation_time": rt_dict(presented),
                    "target_url_error": url_err,
                    "presentation_error": pres_err,
                })
        record["images"] = urls
        return record
    record["target_url"] = getattr(ref, "target_url", None)
    avail, err = read_range(ref, "available_range")
    record["available_range"] = tr_dict(avail)
    if err:
        record["available_range_error"] = err
    return record


def effects_record(item):
    out = []
    for effect in getattr(item, "effects", []) or []:
        out.append({
            "schema": f"{effect.schema_name()}.{effect.schema_version()}",
            "name": effect.name,
            "effect_name": getattr(effect, "effect_name", None),
            "time_scalar": getattr(effect, "time_scalar", None),
            "enabled": getattr(effect, "enabled", True),
        })
    return out


def markers_record(item, ancestor):
    out = []
    for marker in getattr(item, "markers", []) or []:
        projected, err = call(lambda marker=marker: item.transformed_time_range(marker.marked_range, ancestor))
        out.append({
            "name": marker.name,
            "schema": f"{marker.schema_name()}.{marker.schema_version()}",
            "color": str(marker.color),
            "marked_range": tr_dict(marker.marked_range),
            "projected_range": tr_dict(projected),
            "projected_error": err,
            "comment": marker.comment,
        })
    return out


def item_record(item, parent, fallback_id):
    key, ref, refs = active_reference(item)
    return {
        "id": relic_id(item, fallback_id),
        "name": item.name,
        "schema": f"{item.schema_name()}.{item.schema_version()}",
        "enabled": getattr(item, "enabled", None),
        "library": library_ranges(item, parent),
        "active_media_reference_key": key,
        "active_reference": reference_record(ref),
        "media_references": {name: reference_record(value) for name, value in refs.items()},
        "effects": effects_record(item),
        "markers": markers_record(item, parent) if parent is not None else [],
    }


def walk_items(comp, acc, prefix):
    for index, child in enumerate(comp):
        fallback = f"{prefix}[{index}]"
        acc.append(item_record(child, comp, fallback))
        if isinstance(child, (Stack, Track)):
            walk_items(child, acc, relic_id(child, fallback))
    return acc


def file_relative(sample, item):
    if sample is None:
        return None, "no_sample"
    avail, err = call(item.available_range)
    if err or avail is None:
        return None, err or {"error": "no_available_range"}
    start = avail.start_time.rescaled_to(sample.rate)
    return sample - start, None


def relik_retime(item, structural):
    """Labeled Relik sampler. Official transformed_time ignores effects."""
    if structural is None or not hasattr(item, "trimmed_range"):
        return None, "none"
    trimmed, err = call(item.trimmed_range)
    if err or trimmed is None:
        return None, "none"
    source = structural.rescaled_to(trimmed.start_time.rate)
    offset = source - trimmed.start_time
    contract = "none"
    sample = source
    for effect in getattr(item, "effects", []) or []:
        if not getattr(effect, "enabled", True):
            continue
        if isinstance(effect, FreezeFrame):
            sample = trimmed.start_time
            contract = "freeze-frame"
        elif isinstance(effect, LinearTimeWarp):
            scalar = effect.time_scalar
            if scalar > 0:
                sample = trimmed.start_time + RationalTime(offset.value * scalar, offset.rate)
                contract = "linear-time-warp"
            elif scalar < 0:
                one = RationalTime(1, trimmed.start_time.rate)
                last = trimmed.end_time_exclusive() - one
                sample = last + RationalTime(offset.value * scalar, offset.rate)
                contract = "linear-time-warp-reverse"
            else:
                sample = trimmed.start_time
                contract = "linear-time-warp-zero"
    return sample, contract


def adjacent_transition(parent, child, local_time):
    index = None
    for i, candidate in enumerate(parent):
        if candidate is child:
            index = i
            break
    if index is None:
        return None, None
    for offset, role in ((-1, "incoming"), (1, "outgoing")):
        j = index + offset
        if j < 0 or j >= len(parent):
            continue
        sibling = parent[j]
        if not isinstance(sibling, otio.schema.Transition):
            continue
        span, err = call(sibling.range_in_parent)
        if err or span is None or not span.contains(local_time):
            continue
        return sibling, role
    return None, None


def dissolve_weight(transition, local_time, role):
    span = transition.range_in_parent()
    start = span.start_time
    local = local_time.rescaled_to(start.rate)
    offset = local - start
    duration = span.duration.rescaled_to(start.rate)
    if duration.value == 0:
        u = 1.0
    else:
        u = offset.value / duration.value
    weight = (1.0 - u) if role == "outgoing" else u
    return {
        "contract": "relik-smpte-dissolve",
        "not_library_output": True,
        "library_range_in_parent": tr_dict(span),
        "in_offset": rt_dict(transition.in_offset),
        "out_offset": rt_dict(transition.out_offset),
        "u": u,
        "role": role,
        "weight": weight,
    }


def image_sample(ref, sample):
    if not isinstance(ref, ImageSequenceReference) or sample is None:
        return None
    count, err = call(ref.number_of_images_in_sequence)
    frame, frame_err = call(lambda: ref.frame_for_time(sample))
    record = {
        "frame_for_time": frame,
        "frame_for_time_error": frame_err,
        "frame_for_time_ignores_step": True,
        "number_of_images_in_sequence": count,
        "number_of_images_error": err,
        "missing_frame_policy": str(ref.missing_frame_policy).split(".")[-1],
    }
    chosen = None
    if count:
        for index in range(count):
            start, start_err = call(lambda index=index: ref.presentation_time_for_image_number(index))
            if start_err or start is None:
                continue
            if index + 1 < count:
                end, _end_err = call(lambda index=index: ref.presentation_time_for_image_number(index + 1))
            else:
                avail, _avail_err = read_range(ref, "available_range")
                end = None if avail is None else avail.end_time_exclusive()
            if end is None:
                continue
            window = TimeRange.range_from_start_end_time(start, end)
            probe = sample.rescaled_to(start.rate)
            if window.contains(probe):
                chosen = index
                break
    if chosen is None:
        record["image_index"] = None
        record["target_url"] = None
        record["relik_policy"] = record["missing_frame_policy"]
        record["relik_policy_note"] = "Outside presentation windows. Library frame_for_time does not apply hold/black/error."
        return record
    url, url_err = call(lambda chosen=chosen: ref.target_url_for_image_number(chosen))
    record["image_index"] = chosen
    record["target_url"] = url
    record["target_url_error"] = url_err
    record["relik_policy"] = None
    return record


def contribution(parent, child, local_time, timeline_time, track_id, kind):
    structural, struct_err = call(lambda: parent.transformed_time(local_time, child))
    sample, contract = relik_retime(child, structural)
    relative, rel_err = file_relative(sample if sample is not None else structural, child)
    structural_relative, structural_rel_err = file_relative(structural, child)
    transition, role = adjacent_transition(parent, child, local_time)
    weight = 1.0
    transition_record = None
    if transition is not None:
        transition_record = dissolve_weight(transition, local_time, role)
        weight = transition_record["weight"]
    key, ref, _refs = active_reference(child)
    enabled = getattr(child, "enabled", True)
    status = "supported"
    try:
        authored = child.metadata["relic"]["status"]
    except Exception:
        authored = None
    if authored:
        status = authored
    if isinstance(child, Gap):
        status = "gap"
    if not enabled:
        status = "disabled"
    if isinstance(ref, MissingReference):
        status = "missing-media"
    effects = effects_record(child)
    if any(effect["enabled"] and effect["schema"].split(".")[0] not in ("FreezeFrame", "LinearTimeWarp") for effect in effects):
        if status == "supported":
            status = "unsupported-effect"
    image = image_sample(ref, sample if sample is not None else structural)
    bundle = None
    if image and image.get("image_index") is None and image.get("relik_policy") and status == "supported":
        status = "missing-frame-" + image["relik_policy"]
    if image and image.get("target_url"):
        bundle = image["target_url"]
    elif ref is not None and not isinstance(ref, ImageSequenceReference):
        bundle = getattr(ref, "target_url", None)
    return {
        "track_id": track_id,
        "node_id": relic_id(child, child.name or child.schema_name()),
        "name": child.name,
        "schema": f"{child.schema_name()}.{child.schema_version()}",
        "kind": kind,
        "enabled": enabled,
        "contributes": bool(enabled) and status != "disabled",
        "status": status,
        "bundle_path": bundle,
        "active_media_reference_key": key,
        "library_source_time": rt_dict(structural),
        "library_source_time_error": struct_err,
        "library_file_relative_time": rt_dict(structural_relative),
        "library_file_relative_error": structural_rel_err,
        "retime_contract": contract,
        "retime_sample_time": rt_dict(sample),
        "file_relative_time": rt_dict(relative),
        "file_relative_error": rel_err,
        "transition_weight": weight,
        "transition": transition_record,
        "image_sequence": image,
        "effects": effects,
        "timeline_time": rt_dict(timeline_time),
        "local_time": rt_dict(local_time),
    }


def evaluate_composition(comp, local_time, timeline_time, track_id, kind, out):
    for child in comp:
        if isinstance(child, otio.schema.Transition):
            continue
        visible, err = call(lambda child=child: visible_parent_range(comp, child))
        if err or visible is None or not visible.contains(local_time):
            continue
        if isinstance(child, (Stack, Track)):
            child_local, map_err = call(lambda child=child: comp.transformed_time(local_time, child))
            if map_err or child_local is None:
                out.append({
                    "track_id": track_id,
                    "node_id": relic_id(child, child.name),
                    "status": "unplaced",
                    "map_error": map_err,
                })
                continue
            if not getattr(child, "enabled", True):
                out.append(contribution(comp, child, local_time, timeline_time, track_id, kind))
                continue
            evaluate_composition(child, child_local, timeline_time, relic_id(child, track_id), kind, out)
            continue
        out.append(contribution(comp, child, local_time, timeline_time, track_id, kind))
    return out


def evaluate_timeline(timeline, time):
    out = []
    stack = timeline.tracks
    for track in stack:
        track_time, err = call(lambda track=track: stack.transformed_time(time, track))
        if err or track_time is None:
            out.append({"track_id": relic_id(track, track.name), "status": "unplaced", "map_error": err})
            continue
        evaluate_composition(track, track_time, time, relic_id(track, track.name), kind_name(track), out)
    return out


def source_spans(timeline, track_id, query):
    stack = timeline.tracks
    track = None
    for candidate in stack.find_children(Track):
        if relic_id(candidate, candidate.name) == track_id or candidate.name == track_id:
            track = candidate
            break
    if track is None:
        return {"track_id": track_id, "error": "track_not_found", "spans": []}
    start, start_err = call(lambda: stack.transformed_time(query.start_time, track))
    end, end_err = call(lambda: stack.transformed_time(query.end_time_exclusive(), track))
    if start_err or end_err or start is None or end is None:
        return {"track_id": track_id, "error": start_err or end_err, "spans": []}
    local_query = TimeRange.range_from_start_end_time(start, end)
    spans = []
    for child in track:
        if isinstance(child, otio.schema.Transition):
            span = child.range_in_parent()
            hit = intersect_ranges(span, local_query)
            if hit is None:
                continue
            spans.append({
                "node_id": relic_id(child, child.name),
                "schema": f"{child.schema_name()}.{child.schema_version()}",
                "library_range_in_parent": tr_dict(span),
                "intersected_parent_range": tr_dict(hit),
                "includes_transition_handle": False,
                "library_source_range": None,
                "note": "Transition has no transformed_time. Range is range_in_parent.",
            })
            continue
        visible = visible_parent_range(track, child)
        hit = intersect_ranges(visible, local_query)
        if hit is None:
            continue
        src_start, src_start_err = call(lambda hit=hit, child=child: track.transformed_time(hit.start_time, child))
        src_end, src_end_err = call(lambda hit=hit, child=child: track.transformed_time(hit.end_time_exclusive(), child))
        source_range = None
        if src_start is not None and src_end is not None and src_end > src_start:
            source_range = TimeRange.range_from_start_end_time(src_start, src_end)
        trimmed = track.trimmed_range_of_child(child)
        handle = hit.start_time < trimmed.start_time or hit.end_time_exclusive() > trimmed.end_time_exclusive()
        rel_start, _ = file_relative(src_start, child)
        rel_end, _ = file_relative(src_end, child)
        file_range = None
        if rel_start is not None and rel_end is not None and rel_end > rel_start:
            file_range = TimeRange.range_from_start_end_time(rel_start, rel_end)
        _key, ref, _refs = active_reference(child)
        spans.append({
            "node_id": relic_id(child, child.name or child.schema_name()),
            "name": child.name,
            "schema": f"{child.schema_name()}.{child.schema_version()}",
            "enabled": getattr(child, "enabled", None),
            "visible_parent_range": tr_dict(visible),
            "library_range_of_child": tr_dict(track.range_of_child(child)),
            "library_trimmed_range_of_child": tr_dict(trimmed),
            "intersected_parent_range": tr_dict(hit),
            "includes_transition_handle": bool(handle),
            "library_source_range": tr_dict(source_range),
            "library_source_endpoint_error": src_start_err or src_end_err,
            "file_relative_source_range": tr_dict(file_range),
            "bundle_path": None if isinstance(ref, ImageSequenceReference) else getattr(ref, "target_url", None),
        })
    return {
        "track_id": track_id,
        "query_range": tr_dict(query),
        "query_in_track": tr_dict(local_query),
        "spans": spans,
    }


def untrimmed_projection(timeline, item_name):
    stack = timeline.tracks
    found = None
    for item in stack.find_children():
        if item.name == item_name:
            found = item
            break
    if found is None or not hasattr(found, "trimmed_range"):
        return None
    trimmed, err = call(found.trimmed_range)
    if err or trimmed is None:
        return {"error": err}
    start, start_err = call(lambda: found.transformed_time(trimmed.start_time, stack))
    end, end_err = call(lambda: found.transformed_time(trimmed.end_time_exclusive(), stack))
    return {
        "name": item_name,
        "local_trimmed_range": tr_dict(trimmed),
        "projected_to_timeline_stack": tr_dict(
            None if start is None or end is None or not (end > start)
            else TimeRange.range_from_start_end_time(start, end)
        ),
        "error": start_err or end_err,
        "note": "transformed_time of the item's own trimmed_range into the timeline stack. Not range_in_parent.",
    }


def fixture_oracle(name, timeline, times, queries, extra=None):
    rate = timeline.duration().rate
    evaluations = []
    for value in times:
        moment = RationalTime(value, rate)
        evaluations.append({
            "time": rt_dict(moment),
            "contributions": evaluate_timeline(timeline, moment),
        })
    span_queries = []
    for track_id, start, duration in queries:
        query = TimeRange(RationalTime(start, rate), RationalTime(duration, rate))
        span_queries.append(source_spans(timeline, track_id, query))
    record = {
        "timeline_name": timeline.name,
        "global_start_time": rt_dict(timeline.global_start_time) if timeline.global_start_time else None,
        "duration": rt_dict(timeline.duration()),
        "duration_note": "library Timeline.duration(). global_start_time does not shift this.",
        "tracks": [
            {
                "id": relic_id(track, f"track-{index}"),
                "name": track.name,
                "kind": kind_name(track),
                "child_count": len(track),
                "duration": rt_dict(track.duration()),
            }
            for index, track in enumerate(timeline.tracks)
        ],
        "items": walk_items(timeline.tracks, [], "root"),
        "evaluations_at_time": evaluations,
        "source_span_queries": span_queries,
    }
    if extra:
        record.update(extra)
    return record


def collect_media_urls(node):
    found = []
    if isinstance(node, dict):
        url = node.get("target_url")
        if isinstance(url, str) and url.startswith("media/"):
            found.append(url)
        for value in node.values():
            found.extend(collect_media_urls(value))
    elif isinstance(node, list):
        for value in node:
            found.extend(collect_media_urls(value))
    return found


def build_oracle():
    version = assert_library_version()
    standard = build_standard_sample_timeline()
    nested = build_nested_trims_timeline()
    mixed = build_mixed_rates_timeline()
    asymmetric = build_asymmetric_dissolves_timeline()
    # Give the asymmetric track an id the queries use.
    asymmetric.tracks[0].metadata["relic"] = {"id": "track-asymmetric"}
    warp = build_timewarp_freeze_timeline()
    images = build_image_sequence_timeline()
    missing = build_missing_unsupported_timeline()
    duplicate = build_duplicate_tracks_timeline()
    decoder = build_decoder_boundary_timeline()
    oracle = {
        "version": 1,
        "provenance": {
            "otio_version": version,
            "version_asserted": True,
            "recipe": "uv run --with opentimelineio==0.18.1 python3 scripts/generate-otio-fixtures.py",
            "check": "uv run --with opentimelineio==0.18.1 python3 scripts/generate-otio-fixtures.py --check",
            "library_calls": [
                "duration",
                "trimmed_range",
                "visible_range",
                "available_range",
                "range_in_parent",
                "trimmed_range_in_parent",
                "range_of_child",
                "trimmed_range_of_child",
                "handles_of_child",
                "transformed_time",
                "transformed_time_range",
                "frame_for_time",
                "target_url_for_image_number",
                "presentation_time_for_image_number",
                "number_of_images_in_sequence",
            ],
            "not_library": {
                "smpte_dissolve_weight": "u = (t - library range_in_parent.start) / duration. outgoing weight = 1-u, incoming weight = u. Missing neighbor is reported, not replaced with black.",
                "retime_sample_time": "transformed_time ignores effects. Positive scalar: source_start + offset * scalar. Negative scalar: last included frame (end_exclusive minus one source frame) + offset * scalar. Freeze and scalar 0: source_range.start.",
                "file_relative_time": "sample minus available_range.start_time via RationalTime subtraction. Null when available_range cannot be computed.",
                "disabled": "Placement is unchanged. contributes is false.",
                "missing_frame_policy": "The library stores the policy and does not apply it in frame_for_time.",
            },
            "otiod_adapter_note": "opentimelineio 0.18.1 otiod.write_to_file does not write version.txt. otioz writes BUNDLE_VERSION '1.0.0' with no trailing newline. This fixture writes version.txt as 1.0.0 plus a newline because the Relik bundle contract requires that exact text.",
        },
        "fixtures": {
            "standard-sample": fixture_oracle("standard-sample", standard, STANDARD_TIMES, STANDARD_QUERIES),
            "nested-trims": fixture_oracle(
                "nested-trims",
                nested,
                NESTED_TIMES,
                NESTED_QUERIES,
                {"untrimmed_projection": untrimmed_projection(nested, "Inner Clip 1")},
            ),
            "mixed-rates": fixture_oracle("mixed-rates", mixed, MIXED_TIMES, ()),
            "asymmetric-dissolves": fixture_oracle("asymmetric-dissolves", asymmetric, ASYM_TIMES, ASYM_QUERIES),
            "timewarp-freeze": fixture_oracle("timewarp-freeze", warp, WARP_TIMES, ()),
            "image-sequence": fixture_oracle("image-sequence", images, IMAGE_TIMES, ()),
            "missing-unsupported": fixture_oracle("missing-unsupported", missing, MISSING_TIMES, ()),
            "duplicate-tracks": fixture_oracle("duplicate-tracks", duplicate, DUP_TIMES, ()),
        },
    }
    urls = sorted(set(collect_media_urls(oracle)))
    oracle["required_media"] = urls
    return oracle, {
        "standard-sample": standard,
        "nested-trims": nested,
        "mixed-rates": mixed,
        "asymmetric-dissolves": asymmetric,
        "timewarp-freeze": warp,
        "image-sequence": images,
        "missing-unsupported": missing,
        "duplicate-tracks": duplicate,
        "decoder-boundary": decoder,
    }


def oracle_text(oracle) -> str:
    return json.dumps(oracle, indent=2, allow_nan=False) + "\n"


def serialize_timeline(timeline) -> str:
    text = otio.adapters.write_to_string(timeline, "otio_json")
    if not text.endswith("\n"):
        text += "\n"
    return text


def faithful_tokens(text: str) -> str:
    """Keep int64 and non-finite tokens if the writer already emitted them.
    Inject a Marker.1 and an unknown schema object, and record that injection in a sidecar comment line? No:
    the injection is recorded in the oracle by the caller comparing before/after. Here we only ensure the
    raw tokens the writer emitted for Python int / inf survive. Unknown schema is inserted as raw JSON
    and the oracle provenance names the insertion.
    """
    return text


def prepend_to_first_array(text: str, key: str, item: str) -> str:
    """Add one raw item without serializing or introducing a trailing comma."""
    needle = f'"{key}": ['
    start = text.find(needle)
    if start < 0:
        raise ValueError(f'missing "{key}" array')

    content_start = start + len(needle)
    next_token = content_start
    while next_token < len(text) and text[next_token].isspace():
        next_token += 1
    if next_token >= len(text):
        raise ValueError(f'unterminated "{key}" array')

    separator = "" if text[next_token] == "]" else ", "
    return text[:content_start] + item + separator + text[content_start:]


def inject_faithful_tokens(text: str) -> tuple[str, list]:
    patches = []
    # The builder stores Infinity and NaN as strings so the official writer cannot turn them into
    # non-standard JSON by itself. Replace those quoted placeholders with bare tokens, and record it.
    replacements = (
        ('"non_finite_infinity": "Infinity"', '"non_finite_infinity": Infinity'),
        ('"non_finite_nan": "NaN"', '"non_finite_nan": NaN'),
    )
    for old, new in replacements:
        if old in text:
            text = text.replace(old, new, 1)
            patches.append({"replaced": old, "with": new, "reason": "faithful non-finite token"})
        elif new in text:
            patches.append({"already_present": new})
        else:
            patches.append({"missing": old, "reason": "writer did not emit the placeholder"})
    for token in ("9223372036854775807", "-9223372036854775808"):
        patches.append({"int64_token_present": token, "present": token in text})
    unknown = (
        '{"OTIO_SCHEMA": "UnknownVendorEntity.99", "name": "Injected Unknown", '
        '"vendor": "AcmePost", "token": "preserved-exact-value"}'
    )
    # Insert only into the missing-unsupported document, which is serialized alone.
    if unknown not in text and '"children": [' in text:
        text = prepend_to_first_array(text, "children", unknown)
        patches.append({
            "injected": "UnknownVendorEntity.99",
            "where": "first children array",
            "reason": "Official writer cannot construct an unknown schema. Token is injected and labeled.",
        })
    marker1 = (
        '{"OTIO_SCHEMA": "Marker.1", "name": "Legacy Marker", "time": {"OTIO_SCHEMA": "RationalTime.1", '
        '"rate": 24.0, "value": 12.0}, "color": "RED", "metadata": {}}'
    )
    if "Marker.1" not in text and '"markers": [' in text:
        text = prepend_to_first_array(text, "markers", marker1)
        patches.append({
            "injected": "Marker.1",
            "where": "first markers array",
            "reason": "0.18.1 constructs Marker.2. Marker.1 time field is injected and labeled.",
        })
    return text, patches


def write_outputs(root: Path, oracle, timelines, check: bool) -> int:
    fixtures = root / "packages" / "relic-format" / "test" / "fixtures" / "otio"
    edge = fixtures / "edge-cases"
    standard_dir = fixtures / "standard-sample.otiod"
    decoder_dir = fixtures / "decoder-boundary.otiod"
    expected_oracle = oracle_text(oracle)
    files = {
        fixtures / "expected-oracle.json": expected_oracle,
        standard_dir / "content.otio": serialize_timeline(timelines["standard-sample"]),
        standard_dir / "version.txt": "1.0.0\n",
        decoder_dir / "content.otio": serialize_timeline(timelines["decoder-boundary"]),
        decoder_dir / "version.txt": "1.0.0\n",
    }
    missing_text = serialize_timeline(timelines["missing-unsupported"])
    files[edge / "missing-unsupported.otio"] = missing_text
    faithful, patches = inject_faithful_tokens(missing_text)
    oracle["provenance"]["faithful_token_patches"] = patches
    oracle["provenance"]["faithful_tokens_file"] = (
        "edge-cases/faithful-tokens.otio.json is not official-reader input. "
        "It preserves raw int64, non-finite, Marker.1, and unknown-schema tokens for the TS parser. "
        "missing-unsupported.otio is the official writer output and stays readable."
    )
    expected_oracle = oracle_text(oracle)
    files[fixtures / "expected-oracle.json"] = expected_oracle
    files[edge / "faithful-tokens.otio.json"] = faithful
    for name in (
        "nested-trims",
        "mixed-rates",
        "asymmetric-dissolves",
        "timewarp-freeze",
        "image-sequence",
        "duplicate-tracks",
    ):
        files[edge / f"{name}.otio"] = serialize_timeline(timelines[name])
    if check:
        mismatches = []
        for path, body in files.items():
            if not path.exists():
                mismatches.append(f"missing {path}")
                continue
            current = path.read_text()
            if current != body:
                mismatches.append(f"differs {path} committed={len(current)} computed={len(body)}")
        if mismatches:
            print("OTIO oracle check failed:", file=sys.stderr)
            for line in mismatches:
                print(line, file=sys.stderr)
            return 1
        print("OTIO oracle check passed.")
        return 0
    for path, body in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
    print(f"Wrote OTIO fixtures under {fixtures}")
    return 0


def main(argv=None):
    import argparse
    parser = argparse.ArgumentParser(description="Generate or check OTIO 0.18.1 oracle fixtures.")
    parser.add_argument("--check", action="store_true", help="Compare computed fixtures to the tree. Write nothing.")
    parser.add_argument("--oracle-stdout", action="store_true", help="Print expected-oracle.json and write nothing.")
    parser.add_argument("--output-root", type=Path, help="Write fixtures under this root instead of the repo.")
    args = parser.parse_args(argv)
    oracle, timelines = build_oracle()
    if args.oracle_stdout:
        sys.stdout.write(oracle_text(oracle))
        return 0
    if args.check and args.output_root:
        print("--check does not write. Ignoring --output-root.", file=sys.stderr)
    root = Path(__file__).resolve().parent.parent if args.output_root is None or args.check else args.output_root
    if args.output_root is not None and not args.check:
        root = args.output_root
    return write_outputs(root, oracle, timelines, check=args.check)


if __name__ == "__main__":
    raise SystemExit(main())
