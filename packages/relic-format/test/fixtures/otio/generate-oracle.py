#!/usr/bin/env python3
"""
Official OpenTimelineIO v0.18.1 Oracle Generator & Range Evaluator.

Usage:
    uv run --with opentimelineio==0.18.1 python3 generate-oracle.py
or:
    python3 -m pip install opentimelineio==0.18.1
    python3 generate-oracle.py
"""

import importlib.util
from pathlib import Path

repo_root = Path(__file__).resolve().parents[5]
script_path = repo_root / "scripts" / "generate-otio-fixtures.py"
spec = importlib.util.spec_from_file_location("generate_otio_fixtures", script_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

if __name__ == "__main__":
    mod.main()
