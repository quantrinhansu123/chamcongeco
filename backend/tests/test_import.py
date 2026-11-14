import csv
import json
from pathlib import Path
import tempfile
import unittest

from backend.runtime.import_csv import import_csv
from backend.runtime.store import SqliteStore


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.employee = root / "employees.csv"
        self.attendance = root / "attendance.csv"
        self.db = root / "runtime.sqlite3"
        self.write_employees()
        self.attendance.write_text(
            "attendance_date,employee_id,is_arrive,arrived_at,departed_at,last_distance\n2026-11-14,emp_009,true,2026-11-14T08:00:00+07:00,2026-11-14T17:00:00+07:00,0.2\n",
            encoding="utf-8",
        )

    def write_employees(self, vector=None):
        with self.employee.open("w", newline="", encoding="utf-8") as handle:
            writer = csv.writer(handle)
            writer.writerow(["employee_id", "name", "image_filename", "face_encoding", "created_at"])
            writer.writerow(
                [
                    "emp_009",
                    "Synthetic Import",
                    "test.jpg",
                    json.dumps(vector if vector is not None else [0.1] * 128),
                    "2026-01-01T08:00:00",
                ]
            )

    def tearDown(self):
        self.temp.cleanup()

    def run_import(self, apply=False):
        return import_csv(self.employee, self.attendance, self.db, apply=apply)

    def test_dry_run_does_not_create_db_then_idempotent_apply_preserves_source_and_times(self):
        original = self.employee.read_bytes(), self.attendance.read_bytes()
        summary = self.run_import()
        self.assertEqual(summary["naive_timestamps_assumed_local"], 1)
        self.assertFalse(self.db.exists())
        self.run_import(True)
        self.run_import(True)
        store = SqliteStore(self.db)
        self.assertEqual(len(store.list_employees()), 1)
        self.assertTrue(store.list_attendance("2026-11-14")[0]["departed_at"])
        self.assertEqual(original, (self.employee.read_bytes(), self.attendance.read_bytes()))
        next_employee = store.create_employee(dict(name="Next Synthetic", face_encoding=[0.2] * 128))
        self.assertEqual(next_employee["employee_id"], "emp_010")

    def test_invalid_vectors_and_dates_fail_before_writing(self):
        self.write_employees([float("nan")] * 128)
        with self.assertRaises(ValueError):
            self.run_import(True)
        self.assertFalse(self.db.exists())
        self.write_employees()
        self.attendance.write_text(
            "attendance_date,employee_id,is_arrive,arrived_at,last_distance\n2026-11-14,missing,true,2026-11-14T08:00:00,0.2\n"
        )
        with self.assertRaises(ValueError):
            self.run_import(True)
        self.assertFalse(self.db.exists())

    def test_conflicting_attendance_never_overwrites(self):
        self.run_import(True)
        original = self.attendance.read_text()
        self.attendance.write_text(original.replace("08:00:00", "09:00:00"))
        with self.assertRaises(ValueError):
            self.run_import(True)
        self.assertIn("08:00:00", SqliteStore(self.db).list_attendance("2026-11-14")[0]["arrived_at"])
