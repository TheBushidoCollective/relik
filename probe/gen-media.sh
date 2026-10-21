#!/usr/bin/env bash
# Frame-index-coded probe media. 64x16; block 0 is an always-white marker,
# blocks 1..7 carry the 7-bit frame index. Writes only under probe/media.
set -euo pipefail
OUT="$(cd "$(dirname "$0")" && pwd)/media"
mkdir -p "$OUT"
LUM="if(lt(X,8),235,16+219*mod(floor(N/pow(2,floor(X/8)-1)),2))"
VF="format=yuv420p,geq=lum='${LUM}':cb=128:cr=128"
gen() { # name rate dur codec-args...
  local name="$1" rate="$2" dur="$3"
  shift 3
  ffmpeg -y -hide_banner -loglevel error -f lavfi \
    -i "color=c=black:s=64x16:r=${rate}:d=${dur}" -vf "$VF" "$@" "$OUT/$name"
}
gen fr24.mp4 24 2 -c:v libx264 -preset ultrafast -pix_fmt yuv420p
gen fr24b.mp4 24 2 -c:v libx264 -preset medium -pix_fmt yuv420p
gen fr48.mp4 48 2 -c:v libx264 -preset ultrafast -pix_fmt yuv420p
gen fr60.mp4 60 2 -c:v libx264 -preset ultrafast -pix_fmt yuv420p
gen fr2997.mp4 30000/1001 3 -c:v libx264 -preset ultrafast -pix_fmt yuv420p
gen fr30.webm 30 3 -c:v libvpx-vp9 -b:v 200k -pix_fmt yuv420p
gen fr24.webm 24 2 -c:v libvpx-vp9 -b:v 200k -pix_fmt yuv420p
for f in "$OUT"/*; do
  printf '%s ' "$(basename "$f")"
  ffprobe -v error -select_streams v:0 \
    -show_entries stream=codec_name,r_frame_rate,avg_frame_rate,time_base,nb_frames,start_time \
    -of compact=p=0:nk=0 "$f"
done
