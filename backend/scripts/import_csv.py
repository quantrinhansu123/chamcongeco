"""Run from backend: uv run python scripts/import_csv.py --help."""

import argparse
import json
from pathlib import Path

from backend.runtime.import_csv import import_csv
from backend.runtime.settings import Settings

parser = argparse.ArgumentParser(
    description="Validate/import original dlib CSV; sources remain untouched. Default is dry-run."
)
parser.add_argument("--employees", type=Path, required=True)
parser.add_argument("--attendance", type=Path, required=True)
parser.add_argument("--database", type=Path, default=Settings.from_env().data_dir / "attendance.sqlite3")
parser.add_argument("--apply", action="store_true")
args = parser.parse_args()
try:
    print(json.dumps(import_csv(args.employees, args.attendance, args.database, apply=args.apply), indent=2))
except (ValueError, KeyError, OSError) as error:
    parser.exit(1, f"Import aborted: {error}\n")
