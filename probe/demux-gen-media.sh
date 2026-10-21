#!/usr/bin/env bash
set -euo pipefail
OUT="$(cd "$(dirname "$0")" && pwd)/media"
ffmpeg -y -hide_banner -loglevel error -i "$OUT/fr24b.mp4" -c copy "$OUT/fr24b.mov"
ffmpeg -y -hide_banner -loglevel error -itsoffset 0.25 -i "$OUT/fr24b.mp4" -c copy "$OUT/fr24b-offset.mov"
ffmpeg -y -hide_banner -loglevel error -ss 0.25 -i "$OUT/fr24b.mp4" -t 1 -c copy "$OUT/fr24b-trimmed.mov"
LUM="if(lt(X,8),235,16+219*mod(floor(N/pow(2,floor(X/8)-1)),2))"
VF="format=yuv420p,geq=lum='${LUM}':cb=128:cr=128,select='not(mod(n,2))+eq(mod(n,7),3)'"
ffmpeg -y -hide_banner -loglevel error -f lavfi -i 'color=c=black:s=64x16:r=24:d=2' -vf "$VF" -fps_mode vfr -c:v libx264 -preset medium -pix_fmt yuv420p "$OUT/vfr.mp4"
ffmpeg -y -hide_banner -loglevel error -f lavfi -i 'color=c=black:s=64x16:r=24:d=2' -vf "$VF" -fps_mode vfr -c:v libvpx-vp9 -b:v 200k -pix_fmt yuv420p "$OUT/vfr.webm"
