"""Pinned model identity and verified offline preparation; no request-time downloads."""

from hashlib import sha256
from pathlib import Path
import shutil
import tempfile
from urllib.request import Request, urlopen
from zipfile import ZipFile

ASSETS = {
    "det_500m.onnx": "5e4447f50245bbd7966bd6c0fa52938c61474a04ec7def48753668a9d8b4ea3a",
    "w600k_mbf.onnx": "9cc6e4a75f0e2bf0b1aed94578f144d15175f357bdc05e815e5c4a02b319eb4f",
    "2.7_80x80_MiniFASNetV2.onnx": "2e0b0bdcdaf2ed0e8ceae7a8588a8b029c0f1bf2b15876eee942b68ce51bbb29",
    "4_0_0_80x80_MiniFASNetV1SE.onnx": "1e2645be6e42759714f19ee23641366cf3d86cba5f169964880894a1fc188275",
}
MODEL_ID = "buffalo_sc:" + ASSETS["w600k_mbf.onnx"]
LEGACY_MODEL_ID = "dlib-v1"
PACK_URL = "https://github.com/deepinsight/insightface/releases/download/model-zoo/buffalo_sc.zip"
PACK_HASH = "57d31b56b6ffa911c8a73cfc1707c73cab76efe7f13b675a05223bf42de47c72"
PAD_BASE = "https://github.com/serengil/deepface_models/releases/download/v1.0/"


def digest(path: Path):
    with path.open("rb") as handle:
        return sha256(handle.read()).hexdigest()


def verify(directory: Path):
    for name, expected in ASSETS.items():
        path = directory / name
        if not path.is_file() or digest(path) != expected:
            raise RuntimeError(f"Missing or invalid model {name}. Run: python scripts/download_models.py")


def prepare(directory: Path):
    directory.mkdir(parents=True, exist_ok=True)

    def fetch(url: str, target: Path):
        with (
            urlopen(Request(url, headers={"User-Agent": "Attendly-model-setup"}), timeout=120) as response,
            target.open("wb") as handle,
        ):
            shutil.copyfileobj(response, handle, 1024 * 1024)

    with tempfile.TemporaryDirectory(dir=directory) as temporary:
        temp = Path(temporary)
        needed = [
            n
            for n in ("det_500m.onnx", "w600k_mbf.onnx")
            if not (directory / n).is_file() or digest(directory / n) != ASSETS[n]
        ]
        if needed:
            archive = temp / "pack.zip"
            fetch(PACK_URL, archive)
            if digest(archive) != PACK_HASH:
                raise RuntimeError("InsightFace archive checksum mismatch")
            with ZipFile(archive) as zipped:
                for name in needed:
                    member = next(item for item in zipped.infolist() if Path(item.filename).name == name)
                    with zipped.open(member) as source, (temp / name).open("wb") as target:
                        shutil.copyfileobj(source, target)
                    if digest(temp / name) != ASSETS[name]:
                        raise RuntimeError(f"Checksum mismatch: {name}")
                    (temp / name).replace(directory / name)
        for name in list(ASSETS)[2:]:
            if (directory / name).is_file() and digest(directory / name) == ASSETS[name]:
                continue
            fetch(PAD_BASE + name, temp / name)
            if digest(temp / name) != ASSETS[name]:
                raise RuntimeError(f"Checksum mismatch: {name}")
            (temp / name).replace(directory / name)
    verify(directory)
