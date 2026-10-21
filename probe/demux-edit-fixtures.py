#!/usr/bin/env python3
"""Mutate only the tiny generated MP4's edit list for demux API characterization."""
import pathlib
import struct

root = pathlib.Path(__file__).resolve().parent
source = bytearray((root / 'media/fr24b.mp4').read_bytes())
# This is a fixture-only edit: generated x264 MP4 has one elst in the final moov.
positions = {kind: source.index(kind) - 4 for kind in (b'moov', b'trak', b'edts', b'elst')}
e = positions[b'elst']
assert source[e + 8] == 0
assert struct.unpack_from('>I', source, e + 12)[0] == 1
size = struct.unpack_from('>I', source, e)[0]
assert size == 28

short = bytearray(source)
struct.pack_into('>I', short, e + 16, 1000)
(root / 'media/short-edit.mp4').write_bytes(short)

rate = bytearray(source)
struct.pack_into('>h', rate, e + 24, 2)
(root / 'media/rate-edit.mp4').write_bytes(rate)

entry = bytearray(source[e + 16:e + 28])
struct.pack_into('>I', entry, 0, 1000)
loop = bytearray(source[:e + 12]) + struct.pack('>I', 2) + entry + entry + source[e + 28:]
for position in positions.values():
    original_size = struct.unpack_from('>I', source, position)[0]
    struct.pack_into('>I', loop, position, original_size + 12)
(root / 'media/loop-edit.mp4').write_bytes(loop)
print('Wrote focused single-short, media-rate-2, and looped edit-list fixtures')

webm = bytearray((root / 'media/fr30.webm').read_bytes())
w = webm.index(bytes.fromhex('23e383'))
assert webm[w + 3] == 0x84
webm[w:w + 8] = bytes.fromhex('ec86') + bytes(6)
(root / 'media/no-duration.webm').write_bytes(webm)
