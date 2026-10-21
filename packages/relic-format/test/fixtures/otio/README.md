# OTIO 0.18.1 fixtures

These files are the timing and media fixtures for Relik's native OTIO playback. Timing answers come from the official `opentimelineio==0.18.1` Python library. The library does not render pixels, dissolves, or timewarps. Those fields are labeled Relik contracts in `expected-oracle.json` and are not library output.

## Commands

Check, write nothing, exit nonzero on mismatch:

```bash
uv run --with opentimelineio==0.18.1 python3 scripts/generate-otio-fixtures.py --check
bash scripts/generate-otio-media.sh --check
```

Print the oracle only:

```bash
uv run --with opentimelineio==0.18.1 python3 scripts/generate-otio-fixtures.py --oracle-stdout
```

Write a copy somewhere else, leaving the repo tree alone:

```bash
uv run --with opentimelineio==0.18.1 python3 scripts/generate-otio-fixtures.py --output-root /tmp/otio-regen
```

Rewrite the committed fixtures:

```bash
uv run --with opentimelineio==0.18.1 python3 scripts/generate-otio-fixtures.py
bash scripts/generate-otio-media.sh
```

The generator exits if the installed library is not 0.18.1.

## What the library computes

`duration`, `trimmed_range`, `visible_range`, `available_range`, `range_in_parent`, `trimmed_range_in_parent`, `range_of_child`, `trimmed_range_of_child`, `handles_of_child`, `transformed_time`, `transformed_time_range`, `frame_for_time`, `target_url_for_image_number`, `presentation_time_for_image_number`.

`transformed_time(time, to_item)` converts a time that is in `self` into `to_item`. A transition has no `transformed_time`. `range_in_parent` does not include transition handles. The visible parent interval is `range_of_child` extended by `handles_of_child`. A source-span query uses that interval, so a query across a dissolve includes the handles.

`frame_for_time` ignores `frame_step`. The file URL is `target_url_for_image_number(index)`, and the index comes from `presentation_time_for_image_number`. At step 2, one frame of time is still image index 0. A base URL without a trailing slash gets a slash from the library.

A nested child's `range_in_parent` is in its parent, not in timeline time. Project it with `transformed_time`. Do not store that child range as a timeline range.

## What is not library output

SMPTE dissolve weight: `u = (t - library range start) / duration`. Outgoing weight is `1 - u`. Incoming weight is `u`. A missing neighbor is reported. It is not replaced with black.

Retime sample: positive scalar is source start plus offset times scalar. Negative scalar starts at the last included source frame, `end_exclusive` minus one source frame. Freeze and scalar 0 hold the source start. `transformed_time` does not apply these.

File-relative time subtracts `available_range.start_time`. It is null when the library cannot compute `available_range`.

`missing_frame_policy` is stored by the library and not applied by `frame_for_time`.

## Bundle layout

`standard-sample.otiod/` is a directory bundle: `content.otio`, `version.txt`, and flat `media/` names. The 0.18.1 `otiod` adapter does not write `version.txt`. The `otioz` adapter writes `1.0.0` with no trailing newline. This fixture writes `1.0.0` plus a newline because the Relik bundle contract requires that text. Image sequence frames are `media/plate_1001.png` and the other names in `required_media`. There is no `media/vfx_plates/` directory.

`edge-cases/faithful-tokens.otio.json` is not official-reader input. It keeps raw int64, `Infinity`, `NaN`, a `Marker.1` `time` field, and an unknown schema object. `missing-unsupported.otio` is the official writer output and stays readable.

Because it intentionally contains bare `Infinity` and `NaN`, this is the only JSON fixture excluded from Biome parsing in `biome.json`. The dedicated semantic test parses it with `parseOtioJson`, checks token and legacy-schema round trips, and rejects trailing commas. `scripts/generate-otio-fixtures.py --check` keeps the committed text synchronized with the raw-token recipe. All ordinary JSON remains in Biome's includes.

## Media

Video frames carry a bar whose x position is the frame index. Two decoded frames that match mean the offset cannot be proved. `overlay_alpha.webm` and `fx_flare.webm` are VP9 with a real alpha plane: the canvas is transparent before the bar is painted. `secondary_b_prores.mov` and `unsupported_prores.mov` are ProRes. The script refuses to write MJPEG under those names. The profile is whatever `ffprobe` records in `media/media-measured.json`, not a claim made by the filename.

Audio is a chirp, so a wrong source offset is a different frequency.
