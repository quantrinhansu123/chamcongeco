"""SQLite WAL store: each reservation/commit is a cross-process transaction."""

from contextlib import contextmanager
from datetime import datetime
import json
from pathlib import Path
import sqlite3

from .errors import AppError, unavailable


def templates_for(employee: dict, model_id: str) -> list:
    profiles = employee.get("face_profiles") or {}
    if model_id in profiles:
        return profiles[model_id]
    if employee.get("face_model", "dlib-v1") == model_id:
        return employee.get("face_templates") or [employee["face_encoding"]]
    return []


def replace_profile(previous: dict, changes: dict) -> dict:
    profiles = dict(previous.get("face_profiles") or {})
    old_model = previous.get("face_model", "dlib-v1")
    if previous.get("face_encoding"):
        profiles.setdefault(old_model, previous.get("face_templates") or [previous["face_encoding"]])
    profiles[changes["face_model"]] = changes["face_templates"]
    return {**previous, **changes, "face_profiles": profiles}


def public_employee(employee: dict, attendance: dict | None, model_id: str) -> dict:
    attendance = attendance or {}
    return dict(
        employee_id=employee["employee_id"],
        name=employee["name"],
        is_arrive=bool(attendance.get("arrived_at")),
        arrived_at=attendance.get("arrived_at"),
        departed_at=attendance.get("departed_at"),
        requires_reenrollment=not bool(templates_for(employee, model_id)),
    )


def receipt_result(request: dict, employee: dict, row: dict, model_id: str, *, changed: bool) -> dict:
    return dict(
        faces=request["context"]["faces"],
        attendance_updated=[employee["employee_id"]] if changed else [],
        attendance=[public_employee(employee, row, model_id)],
        request_id=request["request_id"],
        status="confirmed",
        action=request["action"],
        replayed=not changed,
    )


class SqliteStore:
    def __init__(self, path: Path, *, cooldown: int = 30, pending_timeout: int = 120):
        self.path, self.cooldown, self.pending_timeout = path, cooldown, pending_timeout
        path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as db:
            db.execute("PRAGMA journal_mode=WAL")
            db.executescript("""
                CREATE TABLE IF NOT EXISTS employees (
                    number INTEGER PRIMARY KEY AUTOINCREMENT,
                    employee_id TEXT UNIQUE,
                    name_key TEXT NOT NULL UNIQUE,
                    profile TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS attendance (
                    attendance_date TEXT NOT NULL,
                    employee_id TEXT NOT NULL REFERENCES employees(employee_id),
                    arrived_at TEXT NOT NULL,
                    departed_at TEXT,
                    last_distance REAL NOT NULL,
                    checkin_photo TEXT,
                    checkout_photo TEXT,
                    PRIMARY KEY(attendance_date,employee_id),
                    CHECK(departed_at IS NULL OR julianday(departed_at) >= julianday(arrived_at))
                );
                CREATE TABLE IF NOT EXISTS punch_requests (
                    request_id TEXT PRIMARY KEY,
                    employee_id TEXT NOT NULL REFERENCES employees(employee_id),
                    attendance_date TEXT NOT NULL,
                    action TEXT NOT NULL CHECK(action IN ('in','out')),
                    status TEXT NOT NULL CHECK(status IN ('pending','confirmed','abandoned')),
                    occurred_at TEXT NOT NULL,
                    created_epoch REAL NOT NULL,
                    model_id TEXT NOT NULL,
                    context TEXT NOT NULL,
                    result TEXT
                );
                CREATE UNIQUE INDEX IF NOT EXISTS one_pending_punch
                    ON punch_requests(employee_id,attendance_date) WHERE status='pending';
            """)

    @contextmanager
    def connection(self, *, write: bool = False):
        db = sqlite3.connect(self.path, timeout=10)
        db.row_factory = sqlite3.Row
        db.execute("PRAGMA foreign_keys=ON")
        db.execute("PRAGMA busy_timeout=10000")
        try:
            if write:
                db.execute("BEGIN IMMEDIATE")
            yield db
            db.commit()
        except sqlite3.Error as error:
            db.rollback()
            raise unavailable() from error
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def close(self):
        pass

    def check_health(self):
        with self.connection() as db:
            db.execute("SELECT 1").fetchone()

    def list_employees(self) -> list[dict]:
        with self.connection() as db:
            return [json.loads(row[0]) for row in db.execute("SELECT profile FROM employees ORDER BY number")]

    def create_employee(self, employee: dict) -> dict:
        with self.connection(write=True) as db:
            try:
                supplied_id = employee.get("employee_id")
                numeric = (
                    int(supplied_id[4:])
                    if supplied_id and supplied_id.startswith("emp_") and supplied_id[4:].isdigit()
                    else None
                )
                cursor = db.execute(
                    "INSERT INTO employees(number,employee_id,name_key,profile) VALUES(?,?,?,?)",
                    (numeric, supplied_id, employee["name"].casefold(), "{}"),
                )
                employee = {**employee, "employee_id": supplied_id or f"emp_{cursor.lastrowid:03d}"}
                db.execute(
                    "UPDATE employees SET employee_id=?,profile=? WHERE number=?",
                    (employee["employee_id"], json.dumps(employee, allow_nan=False), cursor.lastrowid),
                )
                return employee
            except sqlite3.IntegrityError as error:
                raise AppError("duplicate_employee", "Tên hoặc mã nhân viên đã tồn tại.", 409) from error

    def update_face(self, employee_id: str, changes: dict) -> dict:
        with self.connection(write=True) as db:
            row = db.execute("SELECT profile FROM employees WHERE employee_id=?", (employee_id,)).fetchone()
            if row is None:
                raise AppError("employee_not_found", "Không tìm thấy nhân viên.", 404)
            employee = replace_profile(json.loads(row[0]), changes)
            db.execute(
                "UPDATE employees SET profile=? WHERE employee_id=?",
                (json.dumps(employee, allow_nan=False), employee_id),
            )
            return employee

    def list_attendance(self, day: str) -> list[dict]:
        with self.connection() as db:
            return [
                dict(row)
                for row in db.execute("SELECT * FROM attendance WHERE attendance_date=? ORDER BY arrived_at", (day,))
            ]

    @staticmethod
    def _request(row) -> dict | None:
        if row is None:
            return None
        value = dict(row)
        value["context"] = json.loads(value["context"])
        value["result"] = json.loads(value["result"]) if value["result"] else None
        return value

    def get_request(self, request_id: str) -> dict | None:
        with self.connection() as db:
            return self._request(
                db.execute("SELECT * FROM punch_requests WHERE request_id=?", (request_id,)).fetchone()
            )

    def expire_request(self, request_id: str, now: datetime) -> dict:
        with self.connection(write=True) as db:
            db.execute(
                "UPDATE punch_requests SET status='abandoned' WHERE request_id=? AND status='pending' AND created_epoch<?",
                (request_id, now.timestamp() - self.pending_timeout),
            )
            return self._request(
                db.execute("SELECT * FROM punch_requests WHERE request_id=?", (request_id,)).fetchone()
            )

    def reserve(
        self, request_id: str, employee_id: str, action: str, now: datetime, model_id: str, context: dict
    ) -> dict:
        day, timestamp, epoch = now.date().isoformat(), now.isoformat(), now.timestamp()
        with self.connection(write=True) as db:
            previous = self._request(
                db.execute("SELECT * FROM punch_requests WHERE request_id=?", (request_id,)).fetchone()
            )
            if previous:
                if previous["employee_id"] != employee_id:
                    raise AppError("request_conflict", "Lượt chấm công đã thuộc nhân viên khác.", 409)
                if previous["status"] == "pending" and previous["created_epoch"] < epoch - self.pending_timeout:
                    db.execute("UPDATE punch_requests SET status='abandoned' WHERE request_id=?", (request_id,))
                    previous["status"] = "abandoned"
                    return previous
                if previous["status"] == "abandoned":
                    raise AppError("request_expired", "Lượt trước đã hết hạn. Hãy bắt đầu lượt mới.", 409)
                return previous
            db.execute(
                "UPDATE punch_requests SET status='abandoned' WHERE employee_id=? AND attendance_date=? AND status='pending' AND created_epoch<?",
                (employee_id, day, epoch - self.pending_timeout),
            )
            if db.execute(
                "SELECT 1 FROM punch_requests WHERE employee_id=? AND attendance_date=? AND status='pending'",
                (employee_id, day),
            ).fetchone():
                raise AppError(
                    "punch_pending", "Nhân viên đang có lượt chấm công chưa hoàn tất. Vui lòng thử lại.", 409
                )
            employee = db.execute("SELECT profile FROM employees WHERE employee_id=?", (employee_id,)).fetchone()
            if employee is None:
                raise AppError("employee_not_found", "Không tìm thấy nhân viên.", 404)
            employee = json.loads(employee[0])
            row = db.execute(
                "SELECT * FROM attendance WHERE attendance_date=? AND employee_id=?", (day, employee_id)
            ).fetchone()
            saved = dict(row) if row else None
            selected = ("out" if saved else "in") if action == "auto" else action
            if selected == "out" and saved is None:
                raise AppError("arrival_required", "Chưa có giờ vào hôm nay.")
            duplicate = bool(saved and ((selected == "in") or saved["departed_at"]))
            if (
                action == "auto"
                and saved
                and not saved["departed_at"]
                and epoch - datetime.fromisoformat(saved["arrived_at"]).timestamp() < self.cooldown
            ):
                selected, duplicate = "in", True
            request = dict(
                request_id=request_id,
                employee_id=employee_id,
                attendance_date=day,
                action=selected,
                status="confirmed" if duplicate else "pending",
                occurred_at=timestamp,
                created_epoch=epoch,
                model_id=model_id,
                context=context,
                result=None,
            )
            if duplicate:
                request["result"] = receipt_result(request, employee, saved, model_id, changed=False)
            db.execute(
                "INSERT INTO punch_requests VALUES(?,?,?,?,?,?,?,?,?,?)",
                (
                    request_id,
                    employee_id,
                    day,
                    selected,
                    request["status"],
                    timestamp,
                    epoch,
                    model_id,
                    json.dumps(context, allow_nan=False),
                    json.dumps(request["result"]) if duplicate else None,
                ),
            )
            return request

    def complete(self, request_id: str, photo_path: str) -> dict:
        with self.connection(write=True) as db:
            request = self._request(
                db.execute("SELECT * FROM punch_requests WHERE request_id=?", (request_id,)).fetchone()
            )
            if request is None or request["status"] == "abandoned":
                raise AppError("request_expired", "Lượt chấm công không còn hiệu lực.", 409)
            if request["status"] == "confirmed":
                return request["result"]
            day, emp, at = request["attendance_date"], request["employee_id"], request["occurred_at"]
            distance = request["context"]["distance"]
            if request["action"] == "in":
                cursor = db.execute(
                    "INSERT OR IGNORE INTO attendance(attendance_date,employee_id,arrived_at,last_distance,checkin_photo) VALUES(?,?,?,?,?)",
                    (day, emp, at, distance, photo_path),
                )
            else:
                cursor = db.execute(
                    "UPDATE attendance SET departed_at=?,last_distance=?,checkout_photo=? WHERE attendance_date=? AND employee_id=? AND departed_at IS NULL AND julianday(arrived_at)<=julianday(?)",
                    (at, distance, photo_path, day, emp, at),
                )
            changed = cursor.rowcount > 0
            row = db.execute(
                "SELECT * FROM attendance WHERE attendance_date=? AND employee_id=?", (day, emp)
            ).fetchone()
            if row is None:
                raise AppError("arrival_required", "Chưa có giờ vào hôm nay.")
            employee = json.loads(db.execute("SELECT profile FROM employees WHERE employee_id=?", (emp,)).fetchone()[0])
            result = receipt_result(request, employee, dict(row), request["model_id"], changed=changed)
            db.execute(
                "UPDATE punch_requests SET status='confirmed',result=? WHERE request_id=?",
                (json.dumps(result, allow_nan=False), request_id),
            )
            return result
