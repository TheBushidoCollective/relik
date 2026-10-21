#!/usr/bin/env bash
# Generate numerical-color test media for standard-sample.otiod using ffmpeg.
# These media files are designed for deterministic headless-browser pixel decoding,
# multi-track additive audio verification, alpha-compositing, and timecode assertions.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MEDIA_DIR="$REPO_ROOT/packages/relic-format/test/fixtures/otio/standard-sample.otiod/media"
VFX_DIR="$MEDIA_DIR/vfx_plates"

mkdir -p "$MEDIA_DIR" "$VFX_DIR"

if ! command -v ffmpeg &>/dev/null; then
    echo "Warning: ffmpeg not found in PATH. Skipping media generation."
    echo "Install ffmpeg (e.g. brew install ffmpeg) to generate playable video/audio."
    exit 0
fi

echo "Generating test media in $MEDIA_DIR..."

# 1. Primary Grade A: 6.0s (144 frames at 24fps), 1280x720 H.264
# Dark slate background #1e293b, calibration boxes (RGB 30, 41, 59), grid overlay
echo "Generating primary_a.mp4..."
ffmpeg -y -f lavfi -i "color=c=0x1e293b:s=1280x720:r=24:d=6.0" \
    -f lavfi -i "anullsrc=r=48000:cl=stereo" \
    -vf "drawbox=x=100:y=100:w=300:h=150:color=red@1.0:t=fill,\
drawbox=x=450:y=100:w=300:h=150:color=green@1.0:t=fill,\
drawbox=x=800:y=100:w=300:h=150:color=blue@1.0:t=fill,\
drawgrid=width=128:height=72:thickness=2:color=white@0.3" \
    -c:v libx264 -pix_fmt yuv420p -profile:v high -preset ultrafast -tune stillimage \
    -c:a aac -b:a 64k -shortest "$MEDIA_DIR/primary_a.mp4" 2>/dev/null

# 2. Secondary Grade B: 6.0s (144 frames at 24fps), 1280x720 H.264
# Warm amber background #78350f, calibration boxes (RGB 120, 53, 15), grid overlay
echo "Generating secondary_b.mp4..."
ffmpeg -y -f lavfi -i "color=c=0x78350f:s=1280x720:r=24:d=6.0" \
    -f lavfi -i "anullsrc=r=48000:cl=stereo" \
    -vf "drawbox=x=100:y=100:w=300:h=150:color=yellow@1.0:t=fill,\
drawbox=x=450:y=100:w=300:h=150:color=cyan@1.0:t=fill,\
drawbox=x=800:y=100:w=300:h=150:color=magenta@1.0:t=fill,\
drawgrid=width=128:height=72:thickness=2:color=white@0.3" \
    -c:v libx264 -pix_fmt yuv420p -profile:v high -preset ultrafast -tune stillimage \
    -c:a aac -b:a 64k -shortest "$MEDIA_DIR/secondary_b.mp4" 2>/dev/null

# 3. Secondary Grade B ProRes (inactive reference in Clip.2)
echo "Generating secondary_b_prores.mov..."
ffmpeg -y -f lavfi -i "color=c=0x451a03:s=1280x720:r=24:d=1.0" \
    -vf "drawbox=x=200:y=200:w=880:h=320:color=white@0.8:t=fill" \
    -c:v mjpeg -q:v 3 "$MEDIA_DIR/secondary_b_prores.mov" 2>/dev/null

# 4. Overlay Alpha: 5.0s (150 frames at 30fps), 1280x720 VP9 with alpha
# Transparent background with neon cyan box in top-right corner
echo "Generating overlay_alpha.webm..."
ffmpeg -y -f lavfi -i "color=c=black@0.0:s=1280x720:r=30:d=5.0" \
    -vf "format=yuva420p,\
drawbox=x=880:y=40:w=360:h=200:color=0x06b6d4@0.85:t=fill,\
drawbox=x=880:y=40:w=360:h=200:color=white@1.0:t=4" \
    -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 500k "$MEDIA_DIR/overlay_alpha.webm" 2>/dev/null

# 5. Dialogue DX: 10.0s stereo 48000Hz WAV with 440Hz test tone
echo "Generating dx_mic1.wav..."
ffmpeg -y -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=10.0" \
    -af "volume=0.3" -c:a pcm_s16le "$MEDIA_DIR/dx_mic1.wav" 2>/dev/null

# 6. Music MX: 8.0s stereo 48000Hz WAV with 220Hz test tone
echo "Generating mx_bed.wav..."
ffmpeg -y -f lavfi -i "sine=frequency=220:sample_rate=48000:duration=8.0" \
    -af "volume=0.25" -c:a pcm_s16le "$MEDIA_DIR/mx_bed.wav" 2>/dev/null

# 7. FX Flare: 2.0s (48 frames at 24fps) transparent alpha video
echo "Generating fx_flare.webm..."
ffmpeg -y -f lavfi -i "color=c=black@0.0:s=1280x720:r=24:d=2.0" \
    -vf "format=yuva420p,drawbox=x=540:y=260:w=200:h=200:color=0xd946ef@0.6:t=fill" \
    -c:v libvpx-vp9 -pix_fmt yuva420p -b:v 200k "$MEDIA_DIR/fx_flare.webm" 2>/dev/null

# 8. Image Sequence Plates: 48 PNG frames (plate_1001.png to plate_1048.png)
echo "Generating 48 VFX plate frames..."
for i in $(seq 1001 1048); do
    frame_offset=$((i - 1001))
    box_x=$((100 + frame_offset * 20))
    ffmpeg -y -f lavfi -i "color=c=0x0f172a:s=1280x720:d=0.04" \
        -vf "drawbox=x=590:y=310:w=100:h=100:color=white@0.8:t=2,\
drawbox=x=${box_x}:y=500:w=50:h=100:color=0xd946ef@1.0:t=fill" \
        -vframes 1 "$VFX_DIR/plate_${i}.png" 2>/dev/null
done

echo "Media generation complete in $MEDIA_DIR."
