"""Download and verify pinned models once, before starting the server."""

from backend.runtime.assets import prepare
from backend.runtime.settings import Settings

if __name__ == "__main__":
    directory = Settings.from_env().model_dir
    prepare(directory)
    print(f"Verified four model files in {directory}")
