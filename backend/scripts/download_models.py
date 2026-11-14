"""Prepare pinned models without requiring runtime credentials during a build."""

import os
from pathlib import Path

from dotenv import load_dotenv

from backend.runtime.assets import prepare
from backend.runtime.settings import ROOT

if __name__ == "__main__":
    load_dotenv(ROOT / ".env", override=False)
    directory = Path(os.environ.get("FACE_MODEL_DIR") or ROOT / "models")
    prepare(directory)
    print(f"Verified four model files in {directory}")
