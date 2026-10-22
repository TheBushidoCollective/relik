#!/usr/bin/env bash
# Generate or check frame-distinct OTIO fixture media.
# Default writes files. --check measures them and writes nothing.
# A claimed codec that ffmpeg did not produce is a failure, not a warning.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MEDIA_DIR="$REPO_ROOT/packages/relic-format/test/fixtures/otio/standard-sample.otiod/media"
MEASURED="$MEDIA_DIR/media-measured.json"
DECODER_DIR="$REPO_ROOT/packages/relic-format/test/fixtures/otio/decoder-boundary.otiod/media"
DECODER_TIMING="$DECODER_DIR/timing-oracle.json"
CHECK=0
BOUNDARY_ONLY=0
case "${1:-}" in
  "") ;;
  --check) CHECK=1 ;;
  --decoder-boundary) BOUNDARY_ONLY=1 ;;
  *)
    echo "usage: $0 [--check|--decoder-boundary]" >&2
    exit 2
    ;;
esac
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

frame_code_filter() {
  printf "format=yuv420p,geq=lum='if(lt(X,8),235,16+219*mod(floor(N/pow(2,floor(X/8)-1)),2))':cb=128:cr=128"
}

write_decoder_timing() {
  local mode="$1"
  python3 - "$DECODER_DIR" "$DECODER_TIMING" "$mode" <<'PY'
import json
import subprocess
import sys
from pathlib import Path

media = Path(sys.argv[1])
target = Path(sys.argv[2])
mode = sys.argv[3]
names = (
    "fr24.mp4",
    "fr60.mp4",
    "fr24b.mp4",
    "fr24b.mov",
    "fr30.webm",
    "vfr.mp4",
    "short-edit.mp4",
    "rate-edit.mp4",
    "loop-edit.mp4",
    "no-duration.webm",
)
codecs = {
    "fr24.mp4": "h264",
    "fr60.mp4": "h264",
    "fr24b.mp4": "h264",
    "fr24b.mov": "h264",
    "fr30.webm": "vp9",
    "vfr.mp4": "h264",
    "short-edit.mp4": "h264",
    "rate-edit.mp4": "h264",
    "loop-edit.mp4": "h264",
    "no-duration.webm": "vp9",
}
report = {"provenance": {
    "producer": "ffprobe packet and frame timestamps",
    "command": "ffprobe -v error -select_streams v:0 -show_packets -show_frames -show_entries stream=codec_name,time_base,r_frame_rate,avg_frame_rate:packet=pts,dts,duration,pts_time,dts_time,duration_time:frame=best_effort_timestamp,best_effort_timestamp_time,pkt_dts,pkt_dts_time,pict_type,coded_picture_number -of json",
    "notes": {
        "fr30.webm": "Packet PTS are millisecond-quantized. 2/30 seconds is inside [0.033, 0.067), frame 1.",
        "no-duration.webm": "DefaultDuration is replaced in the synthetic bytes. Its terminal packet has no certified browser-reader interval.",
    },
}, "files": {}}
for name in names:
    path = media / name
    if not path.is_file():
        raise SystemExit(f"missing decoder timing fixture {path}")
    raw = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_packets", "-show_frames", "-show_entries",
        "stream=codec_name,time_base,r_frame_rate,avg_frame_rate:packet=pts,dts,duration,pts_time,dts_time,duration_time:frame=best_effort_timestamp,best_effort_timestamp_time,pkt_dts,pkt_dts_time,pict_type,coded_picture_number",
        "-of", "json", str(path),
    ]))
    streams = raw.get("streams") or []
    if len(streams) != 1 or streams[0].get("codec_name") != codecs[name]:
        raise SystemExit(f"{name} is not one {codecs[name]} video stream")
    rows = raw.get("packets_and_frames") or []
    packets = [row for row in rows if row.get("type") == "packet"]
    frames = [row for row in rows if row.get("type") == "frame"]
    if not packets or not frames:
        raise SystemExit(f"{name} has no ffprobe packet/frame timestamps")
    report["files"][name] = {
        "stream": {
            "codec_name": streams[0]["codec_name"],
            "time_base": streams[0]["time_base"],
        },
        "packets": [
            {"pts": row.get("pts"), "duration": row.get("duration")}
            for row in packets
        ],
        "frames": [
            {
                "best_effort_timestamp": row.get("best_effort_timestamp"),
                "pict_type": row.get("pict_type"),
            }
            for row in frames
        ],
    }
for name in ("fr24b.mp4", "fr24b.mov"):
    if not any(frame.get("pict_type") == "B" for frame in report["files"][name]["frames"]):
        raise SystemExit(f"{name} lost its B-frame control")
if bytes.fromhex("23e383") in (media / "no-duration.webm").read_bytes():
    raise SystemExit("no-duration.webm still contains WebM DefaultDuration")
text = json.dumps(report, indent=2) + "\n"
if mode == "check":
    if not target.is_file() or target.read_text() != text:
        raise SystemExit(f"timing oracle differs {target}; regenerate with scripts/generate-otio-media.sh")
else:
    target.write_text(text)
PY
}

check_decoder() {
  local required=(
    fr24.mp4 fr60.mp4 fr24b.mp4 fr24b.mov fr30.webm vfr.mp4
    short-edit.mp4 rate-edit.mp4 loop-edit.mp4 no-duration.webm timing-oracle.json
  )
  local name
  for name in "${required[@]}"; do
    if [[ ! -f "$DECODER_DIR/$name" ]]; then
      echo "missing $DECODER_DIR/$name" >&2
      exit 1
    fi
  done
  assert_codec "$DECODER_DIR/fr24.mp4" h264
  assert_codec "$DECODER_DIR/fr60.mp4" h264
  assert_codec "$DECODER_DIR/fr24b.mp4" h264
  assert_codec "$DECODER_DIR/fr24b.mov" h264
  assert_codec "$DECODER_DIR/fr30.webm" vp9
  assert_codec "$DECODER_DIR/vfr.mp4" h264
  frames_differ "$DECODER_DIR/fr24.mp4"
  frames_differ "$DECODER_DIR/fr60.mp4"
  frames_differ "$DECODER_DIR/fr24b.mp4"
  frames_differ "$DECODER_DIR/fr30.webm"
  write_decoder_timing check
  echo "OTIO decoder timing media check passed."
}

generate_decoder() {
  mkdir -p "$DECODER_DIR"
  rm -f "$DECODER_DIR"/{fr24.mp4,fr60.mp4,fr24b.mp4,fr24b.mov,fr30.webm,vfr.mp4,short-edit.mp4,rate-edit.mp4,loop-edit.mp4,no-duration.webm,timing-oracle.json}
  local coded
  coded="$(frame_code_filter)"
  ffmpeg -y -hide_banner -loglevel error -f lavfi -i "color=c=black:s=64x16:r=24:d=2" \
    -vf "$coded" -c:v libx264 -preset ultrafast -pix_fmt yuv420p "$DECODER_DIR/fr24.mp4"
  ffmpeg -y -hide_banner -loglevel error -f lavfi -i "color=c=black:s=64x16:r=60:d=2" \
    -vf "$coded" -c:v libx264 -preset ultrafast -pix_fmt yuv420p "$DECODER_DIR/fr60.mp4"
  ffmpeg -y -hide_banner -loglevel error -f lavfi -i "color=c=black:s=64x16:r=24:d=2" \
    -vf "$coded" -c:v libx264 -preset medium -pix_fmt yuv420p "$DECODER_DIR/fr24b.mp4"
  ffmpeg -y -hide_banner -loglevel error -i "$DECODER_DIR/fr24b.mp4" -c copy "$DECODER_DIR/fr24b.mov"
  ffmpeg -y -hide_banner -loglevel error -f lavfi -i "color=c=black:s=64x16:r=30:d=3" \
    -vf "$coded" -c:v libvpx-vp9 -b:v 200k -pix_fmt yuv420p "$DECODER_DIR/fr30.webm"
  local vfr
  vfr="format=yuv420p,geq=lum='if(lt(X,8),235,16+219*mod(floor(N/pow(2,floor(X/8)-1)),2))':cb=128:cr=128,select='not(mod(n,2))+eq(mod(n,7),3)'"
  ffmpeg -y -hide_banner -loglevel error -f lavfi -i "color=c=black:s=64x16:r=24:d=2" \
    -vf "$vfr" -fps_mode vfr -c:v libx264 -preset medium -pix_fmt yuv420p "$DECODER_DIR/vfr.mp4"
  python3 - "$DECODER_DIR" <<'PY'
import pathlib
import struct
import sys

media = pathlib.Path(sys.argv[1])
source = bytearray((media / "fr24b.mp4").read_bytes())
positions = {kind: source.index(kind) - 4 for kind in (b"moov", b"trak", b"edts", b"elst")}
edit = positions[b"elst"]
assert source[edit + 8] == 0
assert struct.unpack_from(">I", source, edit + 12)[0] == 1
assert struct.unpack_from(">I", source, edit)[0] == 28

short = bytearray(source)
struct.pack_into(">I", short, edit + 16, 1000)
(media / "short-edit.mp4").write_bytes(short)

rate = bytearray(source)
struct.pack_into(">h", rate, edit + 24, 2)
(media / "rate-edit.mp4").write_bytes(rate)

entry = bytearray(source[edit + 16:edit + 28])
struct.pack_into(">I", entry, 0, 1000)
loop = bytearray(source[:edit + 12]) + struct.pack(">I", 2) + entry + entry + source[edit + 28:]
for position in positions.values():
    struct.pack_into(">I", loop, position, struct.unpack_from(">I", source, position)[0] + 12)
(media / "loop-edit.mp4").write_bytes(loop)

webm = bytearray((media / "fr30.webm").read_bytes())
default_duration = webm.index(bytes.fromhex("23e383"))
assert webm[default_duration + 3] == 0x84
webm[default_duration:default_duration + 8] = bytes.fromhex("ec86") + bytes(6)
(media / "no-duration.webm").write_bytes(webm)
PY
  write_decoder_timing write
}

if [[ "$CHECK" == 1 ]]; then
  check_all
  check_decoder
  exit 0
fi

need_encoder libx264
need_encoder libvpx-vp9
if [[ "$BOUNDARY_ONLY" == 1 ]]; then
  generate_decoder
  check_decoder
  exit 0
fi
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

generate_decoder
check_all
check_decoder
echo "Media generation complete in $MEDIA_DIR and $DECODER_DIR"
