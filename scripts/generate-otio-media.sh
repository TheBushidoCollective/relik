#!/usr/bin/env bash
# Generate or check frame-distinct OTIO fixture media.
# Default writes files. --check measures them and writes nothing.
# A claimed codec that ffmpeg did not produce is a failure, not a warning.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MEDIA_DIR="$REPO_ROOT/packages/relic-format/test/fixtures/otio/standard-sample.otiod/media"
MEASURED="$MEDIA_DIR/media-measured.json"
CHECK=0
if [[ "${1:-}" == "--check" ]]; then
  CHECK=1
fi

if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  echo "ffmpeg and ffprobe are required" >&2
  exit 1
fi

need_encoder() {
  local name="$1"
  if ! ffmpeg -hide_banner -encoders 2>/dev/null | awk '{print $2}' | grep -qx "$name"; then
    echo "ffmpeg encoder $name is not available. Refusing to substitute another codec." >&2
    exit 1
  fi
}

probe_codec() {
  ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,pix_fmt,width,height,nb_frames,duration -of json "$1"
}

assert_codec() {
  local file="$1" want="$2"
  local got
  got="$(ffprobe -v error -select_streams v:0 -show_entries stream=codec_name -of csv=p=0 "$file")"
  if [[ "$got" != "$want" ]]; then
    echo "$file codec is $got, required $want" >&2
    exit 1
  fi
}

frames_differ() {
  local file="$1" a b
  a="$(mktemp)"
  b="$(mktemp)"
  ffmpeg -y -v error -i "$file" -vf "select=eq(n\,0)" -frames:v 1 -f rawvideo -pix_fmt rgb24 "$a"
  ffmpeg -y -v error -i "$file" -vf "select=eq(n\,8)" -frames:v 1 -f rawvideo -pix_fmt rgb24 "$b"
  if cmp -s "$a" "$b"; then
    echo "$file frame 0 and frame 8 are identical. Source offset cannot be proved." >&2
    rm -f "$a" "$b"
    exit 1
  fi
  rm -f "$a" "$b"
}

assert_real_alpha() {
  local file="$1" raw
  raw="$(mktemp)"
  # The default WebM decoder reports yuv420p and drops alpha. libvpx-vp9 returns the plane.
  ffmpeg -y -v error -c:v libvpx-vp9 -i "$file" -frames:v 1 -f rawvideo -pix_fmt rgba "$raw"
  python3 - "$raw" <<'PY'
import sys
data = open(sys.argv[1], "rb").read()
alphas = data[3::4]
if not alphas or min(alphas) != 0 or max(alphas) == 0:
    raise SystemExit("alpha plane is missing or fully opaque/transparent")
print(f"alpha min={min(alphas)} max={max(alphas)} bytes={len(alphas)}")
PY
  rm -f "$raw"
}

check_all() {
  local required=(
    primary_a.mp4 secondary_b.mp4 overlay_alpha.webm fx_flare.webm
    dx_mic1.wav mx_bed.wav secondary_b_prores.mov unsupported_prores.mov
    plate_1001.png plate_1002.png plate_1048.png
    step_0000.png step_0002.png step_0004.png step_0006.png
    signed_-0003.png signed_-0002.png signed_-0001.png signed_0000.png
  )
  local name
  for name in "${required[@]}"; do
    if [[ ! -f "$MEDIA_DIR/$name" ]]; then
      echo "missing $MEDIA_DIR/$name" >&2
      exit 1
    fi
  done
  if [[ -d "$MEDIA_DIR/vfx_plates" ]]; then
    echo "nested media/vfx_plates is not the flat OTIO media namespace" >&2
    exit 1
  fi
  assert_codec "$MEDIA_DIR/primary_a.mp4" h264
  assert_codec "$MEDIA_DIR/secondary_b.mp4" h264
  assert_codec "$MEDIA_DIR/overlay_alpha.webm" vp9
  assert_codec "$MEDIA_DIR/fx_flare.webm" vp9
  assert_codec "$MEDIA_DIR/secondary_b_prores.mov" prores
  assert_codec "$MEDIA_DIR/unsupported_prores.mov" prores
  local pix
  # Default ffprobe pix_fmt is yuv420p even when the VP9 bitstream has alpha.
  # assert_real_alpha decodes with libvpx-vp9 and requires a transparent sample.
  frames_differ "$MEDIA_DIR/primary_a.mp4"
  frames_differ "$MEDIA_DIR/secondary_b.mp4"
  frames_differ "$MEDIA_DIR/overlay_alpha.webm"
  assert_real_alpha "$MEDIA_DIR/overlay_alpha.webm"
  assert_real_alpha "$MEDIA_DIR/fx_flare.webm"
  if cmp -s "$MEDIA_DIR/plate_1001.png" "$MEDIA_DIR/plate_1002.png"; then
    echo "plate frames are identical" >&2
    exit 1
  fi
  echo "OTIO media check passed."
}

if [[ "$CHECK" == 1 ]]; then
  check_all
  exit 0
fi

need_encoder libx264
need_encoder libvpx-vp9
need_encoder prores_ks
mkdir -p "$MEDIA_DIR"
rm -rf "$MEDIA_DIR/vfx_plates"

bar_filter() {
  # Moving 8px bar. N is the frame index, so a wrong source offset lands on a different x.
  local origin="$1"
  printf "geq=r='if(between(X,%s+8*mod(N\\,120),%s+8*mod(N\\,120)+7),255,r(X,Y))':g='if(between(X,%s+8*mod(N\\,120),%s+8*mod(N\\,120)+7),255,g(X,Y))':b='if(between(X,%s+8*mod(N\\,120),%s+8*mod(N\\,120)+7),255,b(X,Y))'" \
    "$origin" "$origin" "$origin" "$origin" "$origin" "$origin"
}

echo "Generating opaque frame-distinct video"
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=0x1e293b:s=640x360:r=24:d=6,format=rgb24" \
  -vf "$(bar_filter 16)" \
  -c:v libx264 -pix_fmt yuv420p -profile:v high -preset ultrafast \
  "$MEDIA_DIR/primary_a.mp4"
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=0x78350f:s=640x360:r=24:d=6,format=rgb24" \
  -vf "$(bar_filter 24)" \
  -c:v libx264 -pix_fmt yuv420p -profile:v high -preset ultrafast \
  "$MEDIA_DIR/secondary_b.mp4"

# Alpha plane exists before the color fill. geq sets a=0, then paints a bar with a=217.
alpha_filter() {
  local scale="$1"
  printf "format=rgba,geq=r='if(between(X,%s*N,%s*N+47),6,0)':g='if(between(X,%s*N,%s*N+47),182,0)':b='if(between(X,%s*N,%s*N+47),212,0)':a='if(between(X,%s*N,%s*N+47)*between(Y,40,159),217,0)'" \
    "$scale" "$scale" "$scale" "$scale" "$scale" "$scale" "$scale" "$scale"
}

echo "Generating transparent VP9"
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=black:s=640x360:r=30:d=5,format=rgba" \
  -vf "$(alpha_filter 4)" \
  -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -b:v 1M \
  "$MEDIA_DIR/overlay_alpha.webm"
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=black:s=640x360:r=24:d=2,format=rgba" \
  -vf "$(alpha_filter 6)" \
  -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -b:v 800k \
  "$MEDIA_DIR/fx_flare.webm"

echo "Generating chirps"
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "aevalsrc=0.3*sin(2*PI*(80+40*t)*t):s=48000:d=10" \
  -c:a pcm_s16le "$MEDIA_DIR/dx_mic1.wav"
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "aevalsrc=0.25*sin(2*PI*(40+15*t)*t):s=48000:d=8" \
  -c:a pcm_s16le "$MEDIA_DIR/mx_bed.wav"

echo "Generating ProRes. No MJPEG substitute."
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=0x451a03:s=640x360:r=24:d=1,format=rgb24" \
  -vf "$(bar_filter 32)" \
  -c:v prores_ks -profile:v 3 \
  "$MEDIA_DIR/secondary_b_prores.mov"
ffmpeg -y -hide_banner -loglevel error \
  -f lavfi -i "color=c=0x111111:s=640x360:r=24:d=1,format=rgb24" \
  -vf "$(bar_filter 40)" \
  -c:v prores_ks -profile:v 5 -pix_fmt yuv444p10le \
  "$MEDIA_DIR/unsupported_prores.mov" \
  || ffmpeg -y -hide_banner -loglevel error \
    -f lavfi -i "color=c=0x111111:s=640x360:r=24:d=1,format=rgb24" \
    -vf "$(bar_filter 40)" \
    -c:v prores_ks -profile:v 3 \
    "$MEDIA_DIR/unsupported_prores.mov"

echo "Generating flat image-sequence frames"
python3 - "$MEDIA_DIR" <<'PY'
import subprocess, sys
from pathlib import Path
media = Path(sys.argv[1])
def png(name, x, color):
    dest = media / name
    subprocess.run([
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"color=c={color}:s=320x180:d=0.04",
        "-vf", f"drawbox=x={x}:y=40:w=16:h=40:color=white:t=fill",
        "-frames:v", "1", str(dest),
    ], check=True)
for i in range(1001, 1049):
    png(f"plate_{i}.png", (i - 1001) * 4, "0x0f172a")
for index, frame in enumerate((0, 2, 4, 6)):
    png(f"step_{frame:04d}.png", index * 20, "0x1e293b")
for index, name in enumerate(("signed_-0003.png", "signed_-0002.png", "signed_-0001.png", "signed_0000.png")):
    png(name, index * 20, "0x3f1d2b")
PY

python3 - "$MEDIA_DIR" "$MEASURED" <<'PY'
import json, subprocess, sys
from pathlib import Path
media = Path(sys.argv[1])
out = Path(sys.argv[2])
rows = {}
for path in sorted(media.iterdir()):
    if path.suffix.lower() not in {".mp4", ".webm", ".mov", ".wav", ".png"}:
        continue
    probe = subprocess.run([
        "ffprobe", "-v", "error", "-show_entries",
        "stream=codec_name,codec_type,pix_fmt,width,height,sample_rate,channels",
        "-of", "json", str(path),
    ], check=True, capture_output=True, text=True)
    rows[path.name] = json.loads(probe.stdout)["streams"]
out.write_text(json.dumps(rows, indent=2) + "\n")
print(f"measured {len(rows)} files")
PY

check_all
echo "Media generation complete in $MEDIA_DIR"
