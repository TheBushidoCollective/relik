#!/usr/bin/env python3
"""Forward to the repo generator so there is one recipe."""
import runpy
import sys
from pathlib import Path

script = Path(__file__).resolve().parents[5] / "scripts" / "generate-otio-fixtures.py"
sys.argv = [str(script), *sys.argv[1:]]
runpy.run_path(str(script), run_name="__main__")
