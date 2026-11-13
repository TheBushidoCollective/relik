#!/usr/bin/env bash
# Writes the rendered-program proof media into OUT_DIR/media/ with ffmpeg only.
#
#   bash generate-program-media.sh OUT_DIR
#
# Video plates are 1280x720 at 30 fps. Each plate has a flat background colour and a 4 px white
# bar in the row band y=600..619 at x = 4*N, where N is the frame number. A decoded bar index is
# therefore the source frame that produced it, which makes timing observable in the pixels.
#
# The bar is drawn with geq, which exposes the frame number as N and the pixel coordinates as X
# and Y. (drawbox has no frame-number variable, so it cannot be used.) The frame-index check in
# the proof verifies the encoding; this comment is not a claim about any particular build.
# The analytic reference uses the same phases and accounts for ffmpeg's default mono-to-stereo
# upmix coefficient (1/sqrt(2) per channel). PCM16 quantization is checked with tolerance.
set -euo pipefail

out="${1:?usage: generate-program-media.sh OUT_DIR}"
media="$out/media"
mkdir -p "$media"

bars() {
  # $1 = background colour (0xRRGGBB), $2 = duration in seconds
  local inside='between(X,4*N,4*N+3)*between(Y,600,619)'
  printf "color=c=%s:s=1280x720:r=30:d=%s,format=rgb24,geq=r='if(%s,255,r(X,Y))':g='if(%s,255,g(X,Y))':b='if(%s,255,b(X,Y))',setparams=range=limited:color_primaries=smpte170m:color_trc=smpte170m:colorspace=smpte170m" \
    "$1" "$2" "$inside" "$inside" "$inside"
}

ffmpeg -y -v error -f lavfi -i "$(bars 0xC82828 4)" \
  -c:v libx264 -pix_fmt yuv420p -color_range tv -colorspace smpte170m -color_primaries smpte170m -color_trc smpte170m -preset veryfast -crf 16 -g 30 -an -movflags +faststart \
  "$media/plate_a.mp4"

ffmpeg -y -v error -f lavfi -i "$(bars 0x2828C8 6)" \
  -c:v libx264 -pix_fmt yuv420p -color_range tv -colorspace smpte170m -color_primaries smpte170m -color_trc smpte170m -preset veryfast -crf 16 -g 30 -an -movflags +faststart \
  "$media/plate_b.mp4"

ffmpeg -y -v error -f lavfi -i "$(bars 0x1EC81E 3)" \
  -c:v libx264 -pix_fmt yuv420p -color_range tv -colorspace smpte170m -color_primaries smpte170m -color_trc smpte170m -preset veryfast -crf 16 -g 30 -an -movflags +faststart \
  "$media/plate_c.mp4"

ffmpeg -y -v error -f lavfi -i "aevalsrc=0.5*sin(2*PI*(200*t+300*t*t)):s=48000:d=6" \
  -ac 2 -c:a pcm_s16le "$media/chirp48.wav"

ffmpeg -y -v error -f lavfi -i "aevalsrc=0.3*sin(2*PI*1000*t):s=44100:d=2" \
  -ac 2 -c:a pcm_s16le "$media/tone441.wav"
