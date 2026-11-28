#!/usr/bin/env python3
"""Authenticate an exact regular-file tarball before creating its staging tree."""
import hashlib
import pathlib
import re
import shutil
import sys
import tarfile

LIMIT = 4 * 1024 * 1024


def verify(archive_path: pathlib.Path, pin_path: pathlib.Path, list_path: pathlib.Path, target: pathlib.Path) -> None:
    pin = pin_path.read_text(encoding='ascii').strip()
    if not re.fullmatch(r'[0-9a-f]{64}', pin):
        raise ValueError('pin')
    if archive_path.is_symlink() or not archive_path.is_file() or archive_path.stat().st_size > LIMIT:
        raise ValueError('archive')
    with archive_path.open('rb') as source:
        if hashlib.file_digest(source, 'sha256').hexdigest() != pin:
            raise ValueError('digest')
    expected = list_path.read_text(encoding='utf-8').splitlines()
    if not expected or expected != sorted(set(expected)):
        raise ValueError('allowlist')
    for name in expected:
        path = pathlib.PurePosixPath(name)
        if (not name or name.startswith('/') or any(part in ('.', '..') for part in path.parts)
                or str(path) != name or '\\' in name):
            raise ValueError('allowlist path')
    with tarfile.open(archive_path, 'r:gz') as tar:
        names = []
        total = 0
        for item in tar:
            names.append(item.name)
            total += item.size
            if (len(names) > len(expected) or item.name not in expected or not item.isfile()
                    or item.issym() or item.islnk() or item.size < 0 or total > LIMIT):
                raise ValueError('member')
        if names != expected:
            raise ValueError('members')
    if target.exists() or target.is_symlink():
        raise ValueError('target')
    target.mkdir(mode=0o700)
    try:
        with tarfile.open(archive_path, 'r:gz') as tar:
            for item in tar:
                destination = target.joinpath(*pathlib.PurePosixPath(item.name).parts)
                destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                source = tar.extractfile(item)
                if source is None:
                    raise ValueError('content')
                with source, destination.open('xb') as output:
                    shutil.copyfileobj(source, output, length=65536)
                destination.chmod(0o700 if item.name.startswith('bin/') else 0o600)
    except BaseException:
        shutil.rmtree(target)
        raise


if __name__ == '__main__':
    try:
        if len(sys.argv) != 5:
            raise ValueError('arguments')
        verify(*(pathlib.Path(arg) for arg in sys.argv[1:]))
    except Exception:
        raise SystemExit('Context bundle refused') from None
