import shutil
import subprocess
from pathlib import Path

import pytest

TESTS = Path(__file__).resolve().parent


@pytest.mark.skipif(shutil.which("node") is None, reason="needs Node")
@pytest.mark.parametrize("script", sorted(p.name for p in TESTS.glob("*.test.js")))
def test_js_suite(script):
    out = subprocess.run(["node", str(TESTS / script)], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stdout + out.stderr
