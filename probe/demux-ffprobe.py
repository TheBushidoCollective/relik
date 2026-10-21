#!/usr/bin/env python3
"""Capture independent container timing for the published-package browser probe."""
import json
import pathlib
import subprocess

root = pathlib.Path(__file__).resolve().parent
names = [
    'fr24.mp4', 'fr24b.mp4', 'fr60.mp4', 'fr2997.mp4',
    'fr30.webm', 'fr24.webm', 'fr24b.mov',
    'fr24b-offset.mov', 'fr24b-trimmed.mov', 'vfr.mp4', 'vfr.webm',
]
report = {}
for name in names:
    output = subprocess.check_output([
        'ffprobe', '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=time_base,start_time,duration,r_frame_rate,avg_frame_rate:packet=pts_time,dts_time,duration_time',
        '-of', 'json', str(root / 'media' / name),
    ])
    report[name] = json.loads(output)
(root / 'demux-ffprobe.json').write_text(json.dumps(report, indent=2) + '\n')
print(f'Captured {len(report)} fixture packet timelines in probe/demux-ffprobe.json')
