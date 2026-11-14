"""Export reviewed source only into a NEW directory, never copy Git history/data.

Usage: python tools/export_public.py --destination ../attendly-public
Refuses existing destinations and scans credentials/private CSV fingerprints
before copying. The source checkout and its remotes are never modified.
"""

import argparse
import csv
import json
import re
import shutil
import subprocess
from hashlib import sha256
from pathlib import Path

ROOT_FILES = {
    "README.md",
    "AGENTS.md",
    "THIRD_PARTY_NOTICES.md",
    ".gitignore",
    ".gitattributes",
    ".dockerignore",
    ".env.example",
    "compose.yaml",
    "render.yaml",
}
BACKEND_FILES = {
    "pyproject.toml",
    "uv.lock",
    "README.md",
    ".python-version",
    ".gitignore",
    ".env.example",
    "Dockerfile",
}
SCRIPTS = {"download_models.py", "import_csv.py", "benchmark_runtime.py", "verify_enrollment.py"}
SQL = {"schema.sql", "003_runtime.sql", "sequence_sync.sql"}
DOCS = {"ARCHITECTURE.md", "MIGRATION.md", "OPERATIONS.md", "VERIFICATION.md", "AUTO_ENROLLMENT.md", "HANDOVER.md", "RENDER.md", "UPSTREAM_SYNC.md"}
TOOLS = {"package.json", "bun.lock", "test-supabase.mjs", "export_public.py", "face-quality-fixtures.json"}
SECRET = re.compile(
    r"(?:sb_secret_[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,})"
)


def allowed(path):
    parts = path.parts
    if any(
        part
        in {".git", ".venv", "node_modules", "__pycache__", "dist", "data", ".agents"}
        for part in parts
    ):
        return False
    if (
        path.suffix
        in {".onnx", ".task", ".wasm", ".pt", ".pth", ".pkl", ".sqlite3", ".csv", ".log", ".zip"}
        or path.name == ".DS_Store"
    ):
        return False
    if len(parts) == 1:
        return path.name in ROOT_FILES
    if parts[0] == "backend":
        return (
            len(parts) == 2
            and path.name in BACKEND_FILES
            or parts[1:3] == ("src", "backend")
            or parts[1] == "tests"
            and path.suffix == ".py"
            or parts[1] == "scripts"
            and path.name in SCRIPTS
            or parts[1] == "supabase"
            and path.name in SQL
        )
    if parts[0] == "frontend":
        return parts[1:3] != ("src", "assets") and parts[1:3] != ('public', 'vision')
    if parts[0] == "docs":
        return (
            len(parts) == 2
            and path.name in DOCS
            or len(parts) == 3
            and parts[1] == "benchmarks"
            and path.suffix == ".json"
        )
    return (
        parts[0] == "LICENSES"
        and path.suffix == ".txt"
        or parts[:2] == (".github", "workflows")
        and path.suffix in {".yml", ".yaml"}
        or parts[0] == "tools"
        and len(parts) == 2
        and path.name in TOOLS
    )


def export(source, destination):
    source, destination = source.resolve(), destination.resolve()
    if (
        destination.exists()
        or destination.is_relative_to(source)
        or source.is_relative_to(destination)
    ):
        raise ValueError(
            "Destination must be a new separate directory, outside the source checkout"
        )
    tracked = subprocess.run(
        [
            "git",
            "-C",
            str(source),
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
            "-z",
        ],
        capture_output=True,
        check=True,
    ).stdout
    paths = sorted(
        {
            Path(item.decode("utf-8"))
            for item in tracked.split(b"\0")
            if item and allowed(Path(item.decode("utf-8")))
        }
    )
    private_names, fingerprints = set(), set()
    for employee_file in [
        source / "backend/data/employees.csv",
        source / "data/employees.csv",
    ]:
        if employee_file.exists():
            with employee_file.open(encoding="utf-8-sig", newline="") as handle:
                for row in csv.DictReader(handle):
                    if len(row.get("name", "").strip()) >= 8:
                        private_names.add(row["name"].strip())
                    if row.get("face_encoding"):
                        vector = json.loads(row["face_encoding"])
                        if len(vector) >= 10:
                            fingerprints.add(json.dumps(vector[:10]))
    manifest = []
    for path in paths:
        full = source / path
        if full.is_symlink() or not full.is_file():
            raise ValueError(f"Only regular source files are allowed: {path}")
        raw = full.read_bytes()
        try:
            content = raw.decode("utf-8-sig")
            if SECRET.search(content) or any(name in content for name in private_names):
                raise ValueError(
                    f"Credential/private employee name found: {path} (value withheld)"
                )
            compact = content.replace(" ", "")
            if any(
                fingerprint[:-1].replace(" ", "") in compact
                for fingerprint in fingerprints
            ):
                raise ValueError(f"Private biometric fingerprint found: {path}")
        except UnicodeDecodeError:
            if path.suffix.lower() not in {".woff2", ".jpg", ".png"}:
                raise ValueError(f"Unreviewed binary type: {path}") from None
        manifest.append(
            {
                "path": path.as_posix(),
                "bytes": len(raw),
                "sha256": sha256(raw).hexdigest(),
            }
        )
    destination.mkdir()
    for path in paths:
        target = destination / path
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / path, target)
    print(
        json.dumps(
            {
                "files": len(paths),
                "bytes": sum(item["bytes"] for item in manifest),
                "credential_and_private_data_scan": "passed",
                "history_copied": False,
                "destination": str(destination),
            },
            indent=2,
        )
    )
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source", type=Path, default=Path(__file__).resolve().parents[1]
    )
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    export(args.source, args.destination)
