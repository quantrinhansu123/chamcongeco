"""Validated, transactional CSV import. Source files are never changed."""

import csv
from datetime import date, datetime
import json
import math
from pathlib import Path
import re
from zoneinfo import ZoneInfo

from .assets import LEGACY_MODEL_ID
from .store import SqliteStore, templates_for


def import_csv(
    employees_path: Path, attendance_path: Path, database: Path, *, apply=False, timezone="Asia/Ho_Chi_Minh"
):
    zone = ZoneInfo(timezone)
    employees, attendance, ids, names, days = [], [], set(), set(), set()
    skipped = 0
    assumed_timezone = 0

    def timestamp(raw):
        nonlocal assumed_timezone
        value = datetime.fromisoformat(raw)
        if value.tzinfo is None:
            value = value.replace(tzinfo=zone)
            assumed_timezone += 1
        return value.astimezone(zone).isoformat()

    with employees_path.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            employee_id = row["employee_id"].strip()
            name = " ".join(row["name"].split())
            vector = json.loads(row["face_encoding"])
            if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", employee_id) or not name or len(name) > 120:
                raise ValueError("Invalid employee ID/name in source CSV")
            if employee_id in ids or name.casefold() in names:
                raise ValueError("Duplicate employee ID/name in source CSV")
            if (
                not isinstance(vector, list)
                or len(vector) != 128
                or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in vector)
            ):
                raise ValueError("Source CSV must contain finite 128-dimensional dlib vectors")
            ids.add(employee_id)
            names.add(name.casefold())
            employees.append(
                dict(
                    employee_id=employee_id,
                    name=name,
                    image_filename=Path(row.get("image_filename", "").replace("\\", "/")).name,
                    face_encoding=vector,
                    face_templates=[vector],
                    face_model=LEGACY_MODEL_ID,
                    face_profiles={LEGACY_MODEL_ID: [vector]},
                    created_at=timestamp(row["created_at"]),
                )
            )
    with attendance_path.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            state = row.get("is_arrive", "true").strip().lower()
            if state in {"false", "0", "no"}:
                skipped += 1
                continue
            if state not in {"true", "1", "yes"}:
                raise ValueError("Invalid is_arrive in source CSV")
            employee_id = row["employee_id"].strip()
            day = date.fromisoformat(row["attendance_date"]).isoformat()
            arrived = timestamp(row["arrived_at"])
            departed = timestamp(row["departed_at"]) if row.get("departed_at") else None
            distance = float(row["last_distance"])
            if (
                employee_id not in ids
                or (day, employee_id) in days
                or datetime.fromisoformat(arrived).date().isoformat() != day
            ):
                raise ValueError("Unknown employee, duplicate attendance, or inconsistent date in CSV")
            if (
                not math.isfinite(distance)
                or distance < 0
                or (departed and datetime.fromisoformat(departed) < datetime.fromisoformat(arrived))
            ):
                raise ValueError("Invalid attendance time/distance in CSV")
            days.add((day, employee_id))
            attendance.append((day, employee_id, arrived, departed, distance))
    summary = dict(
        employees=len(employees),
        attendance=len(attendance),
        inactive_rows_skipped=skipped,
        naive_timestamps_assumed_local=assumed_timezone,
        applied=apply,
    )
    if not apply:
        # Dry-run validates all input without even creating the destination DB.
        return summary
    store = SqliteStore(database)
    with store.connection(write=True) as db:
        for employee in employees:
            old = db.execute("SELECT profile FROM employees WHERE employee_id=?", (employee["employee_id"],)).fetchone()
            if old:
                saved = json.loads(old[0])
                if (
                    saved["name"] != employee["name"]
                    or templates_for(saved, LEGACY_MODEL_ID) != employee["face_templates"]
                ):
                    raise ValueError("Existing employee differs; import aborted without overwriting")
                continue
            emp_id = employee["employee_id"]
            number = int(emp_id[4:]) if emp_id.startswith("emp_") and emp_id[4:].isdigit() else None
            db.execute(
                "INSERT INTO employees(number,employee_id,name_key,profile) VALUES(?,?,?,?)",
                (number, emp_id, employee["name"].casefold(), json.dumps(employee, allow_nan=False)),
            )
        for row in attendance:
            old = db.execute(
                "SELECT attendance_date,employee_id,arrived_at,departed_at,last_distance FROM attendance WHERE attendance_date=? AND employee_id=?",
                row[:2],
            ).fetchone()
            if old:
                if tuple(old) != row:
                    raise ValueError("Existing attendance differs; import aborted without overwriting")
                continue
            db.execute(
                "INSERT INTO attendance(attendance_date,employee_id,arrived_at,departed_at,last_distance) VALUES(?,?,?,?,?)",
                row,
            )
    return summary
