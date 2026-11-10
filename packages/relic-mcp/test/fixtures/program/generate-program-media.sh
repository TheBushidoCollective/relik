#!/usr/bin/env bash
# Writes the rendered-program proof media into OUT_DIR/media/ with ffmpeg only.
#
#   bash generate-program-media.sh OUT_DIR
#
# Video plates are 1280x720 at 30 fps. Each plate has a flat background colour and a 4 px white
# bar in the row band y=600..619 at x = 4*n, where n is the frame number. A decoded bar index is
# therefore the source frame that produced it, which makes timing observable in the pixels.
# Audio formulas are duplicated verbatim in test/otio-program-reference.ts; the reference uses
# the same formulas analytically, so the audio check does not depend on this encoder.
set -euo pipefail

out="${1:?usage: generate-program-media.sh OUT_DIR}"
media="$out/media"
mkdir -p "$media"

bars() {
  # $1 = background colour (0xRRGGBB)
  printf 'color=c=%s:s=1280x720:r=30:d=%s,drawbox=x=4*n:y=600:w=4:h=20:color=white:t=fill' "$1" "$2"
}

ffmpeg -y -v error -f lavfi -i "$(bars 0xC82828 4)" \
  -c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 16 -g 30 -an -movflags +faststart \
  "$media/plate_a.mp4"

ffmpeg -y -v error -f lavfi -i "$(bars 0x2828C8 6)" \
  -c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 16 -g 30 -an -movflags +faststart \
  "$media/plate_b.mp4"

ffmpeg -y -v error -f lavfi -i "$(bars 0x1EC81E 3)" \
  -c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 16 -g 30 -an -movflags +faststart \
  "$media/plate_c.mp4"

ffmpeg -y -v error -f lavfi -i "aevalsrc=0.5*sin(2*PI*(200*t+300*t*t)):s=48000:d=6" \
  -ac 2 -c:a pcm_s16le "$media/chirp48.wav"

ffmpeg -y -v error -f lavfi -i "aevalsrc=0.3*sin(2*PI*1000*t):s=48000:d=2" \
  -ac 2 -c:a pcm_s16le "$media/tone48.wav"

ffmpeg -y -v error -f lavfi -i "aevalsrc=0.3*sin(2*PI*1000*t):s=44100:d=2" \
  -ac 2 -c:a pcm_s16le "$media/tone441.wav"
