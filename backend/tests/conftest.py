"""The old regression suite requires the explicitly optional dlib adapter."""

import importlib.util
from pathlib import Path

if importlib.util.find_spec("dlib") is None:
    collect_ignore = [
        path.name
        for path in Path(__file__).parent.glob("test_*.py")
        if path.name not in {"test_runtime.py", "test_import.py", "test_transport.py", "test_quality.py"}
    ]
