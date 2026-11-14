"""Atomically published gallery snapshots; lookup never fetches face vectors."""

from dataclasses import dataclass
from threading import Lock
from time import monotonic

import numpy as np

from .assets import LEGACY_MODEL_ID
from .errors import AppError
from .store import templates_for


@dataclass(frozen=True)
class Snapshot:
    employees: tuple[dict, ...]
    matrix: np.ndarray
    identities: tuple[str, ...]
    refreshed_at: float


class Gallery:
    def __init__(self, store, vision, max_age: float = 120):
        self.store, self.vision, self.max_age = store, vision, max_age
        self._refresh_lock = Lock()
        self._snapshot = None

    def refresh(self):
        with self._refresh_lock:
            records = self.store.list_employees()
            matrix, identities, employees = [], [], []
            for employee in records:
                templates = templates_for(employee, self.vision.model_id)
                # Preserve only public metadata in the snapshot's employee list.
                employees.append(
                    {"employee_id": employee["employee_id"], "name": employee["name"], "compatible": bool(templates)}
                )
                for template in templates:
                    vector = np.asarray(template, dtype=np.float32)
                    if vector.shape != (self.vision.dimensions,) or not np.isfinite(vector).all():
                        raise AppError(
                            "invalid_gallery", "Hồ sơ khuôn mặt không hợp lệ; cần quản trị viên kiểm tra.", 503
                        )
                    if self.vision.model_id != LEGACY_MODEL_ID:
                        norm = np.linalg.norm(vector)
                        if norm < 1e-8:
                            raise AppError("invalid_gallery", "Hồ sơ khuôn mặt không hợp lệ.", 503)
                        vector = vector / norm
                    matrix.append(vector)
                    identities.append(employee["employee_id"])
            values = np.ascontiguousarray(matrix, dtype=np.float32).reshape(-1, self.vision.dimensions)
            values.flags.writeable = False
            self._snapshot = Snapshot(tuple(employees), values, tuple(identities), monotonic())

    def snapshot(self) -> Snapshot:
        value = self._snapshot
        if value is None or monotonic() - value.refreshed_at > self.max_age:
            raise AppError("gallery_unavailable", "Danh sách khuôn mặt chưa được đồng bộ. Vui lòng thử lại.", 503)
        return value

    def match(self, embedding, *, threshold: float, margin: float, exclude: str | None = None):
        snapshot = self.snapshot()
        if not len(snapshot.identities):
            return None, None
        vector = np.asarray(embedding, dtype=np.float32)
        if vector.shape != (self.vision.dimensions,) or not np.isfinite(vector).all():
            raise AppError("model_output", "Bộ nhận diện trả dữ liệu không hợp lệ.", 503)
        legacy = self.vision.model_id == LEGACY_MODEL_ID
        scores = (
            -np.linalg.norm(snapshot.matrix - vector, axis=1)
            if legacy
            else snapshot.matrix @ (vector / max(np.linalg.norm(vector), 1e-8))
        )
        by_person = {}
        for identity, score in zip(snapshot.identities, scores, strict=True):
            if identity != exclude:
                by_person[identity] = max(by_person.get(identity, -float("inf")), float(score))
        ranked = sorted(by_person.items(), key=lambda pair: pair[1], reverse=True)
        if not ranked:
            return None, None
        employee_id, best = ranked[0]
        if not legacy:
            best = float(np.clip(best, -1, 1))
        accepted = best >= (-0.45 if legacy else threshold)
        advantage = 0.05 if legacy else margin
        if len(ranked) > 1 and best - ranked[1][1] < advantage:
            accepted = False
        return (employee_id if accepted else None), (-best if legacy else 1 - best)

    def employees_with_attendance(self, rows: list[dict]):
        by_person = {row["employee_id"]: row for row in rows}
        return [
            dict(
                employee_id=employee["employee_id"],
                name=employee["name"],
                is_arrive=bool(by_person.get(employee["employee_id"], {}).get("arrived_at")),
                arrived_at=by_person.get(employee["employee_id"], {}).get("arrived_at"),
                departed_at=by_person.get(employee["employee_id"], {}).get("departed_at"),
                requires_reenrollment=not employee["compatible"],
            )
            for employee in self.snapshot().employees
        ]
