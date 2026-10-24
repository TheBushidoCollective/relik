#!/usr/bin/env python3
"""
Generate security and adversarial .otioz archive test fixtures.

Creates test archives to verify that reader and bundle parsers reject:
1. Directory traversal paths (e.g. media/../../etc/passwd)
2. Absolute paths (e.g. /etc/passwd)
3. POSIX symlink entries
4. Duplicate canonical entry names
5. Invalid CRC32 checksums
6. Decompression expansion bombs exceeding the 100 MiB local ceiling

Usage:
    python3 security-traversal.py
"""

import io
import struct
import zipfile
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent / "edge-cases"
OUT_DIR.mkdir(parents=True, exist_ok=True)

MINIMAL_OTIO = b'{"OTIO_SCHEMA": "Timeline.1", "name": "Security Test", "tracks": {"OTIO_SCHEMA": "Stack.1", "children": []}}'
VERSION_TXT = b'1.0.0\n'


def create_traversal_archive():
    """ZIP with directory traversal path."""
    dest = OUT_DIR / "security-traversal.otioz"
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("version.txt", VERSION_TXT)
        z.writestr("content.otio", MINIMAL_OTIO)
        z.writestr("media/../../etc/passwd", b"root:x:0:0:root:/root:/bin/sh\n")
    print(f"Created {dest.name}")


def create_duplicate_archive():
    """ZIP with duplicate canonical entry names."""
    dest = OUT_DIR / "security-duplicate.otioz"
    # Python zipfile allows writing duplicate entries if raw
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("version.txt", VERSION_TXT)
        z.writestr("content.otio", MINIMAL_OTIO)
        z.writestr("media/plate.png", b"IMAGE_A")
        z.writestr("media/plate.png", b"IMAGE_B")
    print(f"Created {dest.name}")


def create_symlink_archive():
    """ZIP containing a POSIX symlink entry."""
    dest = OUT_DIR / "security-symlink.otioz"
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("version.txt", VERSION_TXT)
        z.writestr("content.otio", MINIMAL_OTIO)
        zinfo = zipfile.ZipInfo("media/link.mp4")
        # 0o120000 is S_IFLNK (symbolic link)
        zinfo.create_system = 3  # Unix
        zinfo.external_attr = (0o120777) << 16
        z.writestr(zinfo, b"/etc/passwd")
    print(f"Created {dest.name}")


def create_crc_archive():
    """ZIP with intentionally corrupted CRC32."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:
        z.writestr("version.txt", VERSION_TXT)
        z.writestr("content.otio", MINIMAL_OTIO)
        z.writestr("media/test.mp4", b"VALID_BYTES")

    data = bytearray(buf.getvalue())
    # Corrupt a byte in the central directory or payload to force CRC mismatch
    # Find "VALID_BYTES" and change a byte without changing header CRC
    idx = data.find(b"VALID_BYTES")
    if idx != -1:
        data[idx] = ord(b"X")

    dest = OUT_DIR / "security-crc.otioz"
    dest.write_bytes(data)
    print(f"Created {dest.name}")


def create_decompression_bomb_archive():
    """ZIP with uncompressed size > 100 MiB (105 MiB) highly compressed."""
    dest = OUT_DIR / "security-bomb.otioz"
    with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("version.txt", VERSION_TXT)
        z.writestr("content.otio", MINIMAL_OTIO)
        # 105 MiB of zeroes compresses to ~100 KB
        bomb_data = b"\x00" * (105 * 1024 * 1024)
        z.writestr("media/bomb.dat", bomb_data)
    print(f"Created {dest.name}")


def main():
    create_traversal_archive()
    create_duplicate_archive()
    create_symlink_archive()
    create_crc_archive()
    create_decompression_bomb_archive()
    print("Security archives generated.")


if __name__ == "__main__":
    main()
