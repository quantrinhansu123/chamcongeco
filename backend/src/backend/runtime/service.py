from collections import OrderedDict
from datetime import datetime
from threading import Lock
from time import monotonic
from zoneinfo import ZoneInfo

import numpy as np

from .assets import LEGACY_MODEL_ID
from .errors import AppError
from .gallery import Gallery
from .settings import Settings
from .store import replace_profile


class AttendanceApplication:
    def __init__(self, settings: Settings, store, photos, vision, clock=None):
        self.settings, self.store, self.photos, self.vision = settings, store, photos, vision
        self.clock = clock or (lambda: datetime.now(ZoneInfo(settings.timezone)))
        self.gallery = Gallery(store, vision, settings.gallery_max_age_seconds)
        self._enrollment_lock = Lock()
        self._preflight_lock = Lock()
        self._receipts = OrderedDict()
        self._receipt_lock = Lock()

    def warm_up(self):
        self.vision.warm_up()
        self.photos.initialize()
        self.gallery.refresh()

    def close(self):
        self.photos.close()
        self.store.close()

    def employees(self, day=None):
        day = day or self.clock().date().isoformat()
        return self.gallery.employees_with_attendance(self.store.list_attendance(day))

    def validate_enrollment(self, raw: bytes, consent: bool, pose: str, reference: bytes | None = None):
        """Stateless: no profile, photo, receipt, gallery refresh or vector in HTTP."""
        if not consent:
            raise AppError("consent_required", "Cần xác nhận nhân viên đã đồng ý trước khi kiểm tra khuôn mặt.")
        if pose != "front" and reference is None:
            raise AppError("reference_required", "Cần ảnh nhìn thẳng đã được kiểm tra trước khi thu góc tiếp theo.")
        if not self._preflight_lock.acquire(blocking=False):
            raise AppError("busy", "Máy chủ đang kiểm tra ảnh khác. Vui lòng giữ yên một chút.", 429)
        try:
            analysis = self.vision.analyze(raw, liveness=False)
            if len(analysis.faces) != 1:
                raise AppError("face_count", "Mỗi ảnh đăng ký phải có đúng một khuôn mặt.")
            if reference is not None:
                try:
                    original = self.vision.analyze(reference, liveness=False)
                except AppError as error:
                    if error.status in {429, 503}:
                        raise
                    raise AppError("reference_invalid", "Ảnh nhìn thẳng chưa đạt. Hãy thu lại từ đầu.") from error
                if len(original.faces) != 1:
                    raise AppError("reference_invalid", "Ảnh nhìn thẳng chưa đạt. Hãy thu lại từ đầu.")
                if not self._same_person(analysis.faces[0].embedding, original.faces[0].embedding):
                    raise AppError(
                        "different_faces", "Ảnh chưa khớp với góc nhìn thẳng. Hãy để cùng một người trước camera."
                    )
            return dict(valid=True, pose=pose, reference_checked=reference is not None, quality=analysis.quality)
        finally:
            self._preflight_lock.release()

    def _same_person(self, vector, reference):
        return (
            np.linalg.norm(np.asarray(vector) - reference) <= 0.45
            if self.vision.model_id == LEGACY_MODEL_ID
            else float(np.asarray(vector) @ reference) >= self.settings.cosine_threshold
        )

    def enroll(
        self,
        name: str,
        images: list[tuple[str, bytes]],
        consent: bool,
        employee_id=None,
        *,
        capture_mode="upload",
        pose_labels=None,
    ):
        if not consent:
            raise AppError("consent_required", "Cần xác nhận nhân viên đã đồng ý trước khi lưu khuôn mặt.")
        name = " ".join(name.split())
        if not name or len(name) > 120:
            raise AppError("invalid_name", "Họ tên phải có từ 1 đến 120 ký tự.")
        if not 1 <= len(images) <= 5:
            raise AppError("image_count", "Chọn từ 1 đến 5 ảnh rõ mặt.")
        if capture_mode == "guided" and (len(images) != 5 or pose_labels != ["front", "left", "right", "up", "down"]):
            raise AppError("pose_set", "Cần đủ 5 góc: thẳng, trái, phải, ngẩng và cúi.")
        vectors = []
        for index, (_, raw) in enumerate(images):
            try:
                analysis = self.vision.analyze(raw, liveness=False)
            except AppError as error:
                raise AppError(error.code, error.message, error.status, image_index=index) from error
            if len(analysis.faces) != 1:
                raise AppError("face_count", "Mỗi ảnh đăng ký phải có đúng một khuôn mặt.", image_index=index)
            vectors.append(np.asarray(analysis.faces[0].embedding))
        for index, vector in enumerate(vectors[1:], start=1):
            if not self._same_person(vector, vectors[0]):
                raise AppError(
                    "different_faces", "Các ảnh chưa khớp cùng một người. Hãy chụp lại rõ mặt.", image_index=index
                )
        with self._enrollment_lock:
            # Include enrollments completed on other workers before duplicate checks.
            self.gallery.refresh()
            duplicate, _ = self.gallery.match(
                vectors[0], threshold=max(0.65, self.settings.cosine_threshold), margin=0, exclude=employee_id
            )
            if duplicate:
                raise AppError("duplicate_face", "Khuôn mặt đã có hồ sơ. Hãy chọn cập nhật nhân viên đó.", 409)
            now = self.clock().isoformat()
            changes = dict(
                face_encoding=vectors[0].tolist(),
                face_templates=[vector.tolist() for vector in vectors],
                face_model=self.vision.model_id,
                face_updated_at=now,
                consented_at=now,
                image_filename=images[0][0],
            )
            if employee_id:
                employee = self.store.update_face(employee_id, changes)
            else:
                employee = self.store.create_employee(replace_profile(dict(name=name, created_at=now), changes))
            self.gallery.refresh()
        return dict(
            employee_id=employee["employee_id"],
            name=employee["name"],
            image_filename=employee["image_filename"],
            template_count=len(vectors),
        )

    def request_status(self, request_id: str):
        with self._receipt_lock:
            cached = self._receipts.get(request_id)
            if cached and monotonic() - cached[0] < 300:
                return {**cached[1], "replayed": True}
        request = self.store.get_request(request_id)
        if request is None:
            return None
        if (
            request["status"] == "pending"
            and request["created_epoch"] < self.clock().timestamp() - self.settings.pending_timeout_seconds
        ):
            request = self.store.expire_request(request_id, self.clock())
        if request["status"] == "confirmed":
            return {**request["result"], "replayed": True}
        return dict(request_id=request_id, status=request["status"])

    def recognize(self, raw: bytes, request_id: str, action: str = "auto"):
        previous = self.request_status(request_id)
        if previous and previous["status"] == "confirmed":
            return previous
        if previous and previous["status"] == "abandoned":
            raise AppError("request_expired", "Lượt trước đã hết hạn. Hãy bắt đầu lượt mới.", 409)
        analysis = self.vision.analyze(raw, liveness=True)
        if len(analysis.faces) > 1:
            raise AppError("face_count", "Chỉ một người được đứng trước camera khi chấm công.")
        faces = []
        match = None
        for face in analysis.faces:
            employee_id, distance = self.gallery.match(
                face.embedding, threshold=self.settings.cosine_threshold, margin=self.settings.recognition_margin
            )
            employee = next(
                (item for item in self.gallery.snapshot().employees if item["employee_id"] == employee_id), None
            )
            top, right, bottom, left = face.location
            faces.append(
                dict(
                    employee_id=employee_id,
                    name=employee["name"] if employee else "Chưa nhận diện",
                    distance=distance,
                    location=dict(top=top, right=right, bottom=bottom, left=left),
                )
            )
            if employee:
                match = (employee_id, distance)
        if match is None:
            return dict(
                faces=faces,
                attendance_updated=[],
                attendance=[],
                request_id=request_id,
                status="unmatched",
                action=None,
                replayed=False,
            )
        request = self.store.reserve(
            request_id, match[0], action, self.clock(), self.vision.model_id, dict(faces=faces, distance=match[1])
        )
        if request["status"] == "abandoned":
            raise AppError("request_expired", "Lượt trước đã hết hạn. Hãy bắt đầu lượt mới.", 409)
        if request["status"] == "confirmed":
            result = {**request["result"], "replayed": True}
        else:
            path = self.photos.save(request, analysis.jpeg())
            result = self.store.complete(request_id, path)
        with self._receipt_lock:
            self._receipts[request_id] = (monotonic(), result)
            self._receipts.move_to_end(request_id)
            while len(self._receipts) > 1000:
                self._receipts.popitem(last=False)
        return result
