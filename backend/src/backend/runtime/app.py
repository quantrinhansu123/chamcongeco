import asyncio
from contextlib import asynccontextmanager, suppress
from datetime import date as Date
import hmac
import json
import logging
from pathlib import Path
from time import perf_counter
from typing import Annotated, Literal
from uuid import UUID

from fastapi import Depends, FastAPI, File, Form, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException
from backend.logging_config import configure_logging

from .errors import AppError
from .photos import LocalPhotos, SupabasePhotos
from .quality import quality_policy
from .service import AttendanceApplication
from .schemas import (
    EmployeeAttendance,
    EmployeeCreated,
    RecognitionResponse,
    PendingRequest,
    Session,
    QualityPolicy,
    EnrollmentValidation,
)
from .settings import Settings
from .store import SqliteStore
from .supabase import SupabaseStore, create_client
from .vision import Vision

logger = logging.getLogger(__name__)


class BodyLimit:
    def __init__(self, app, limit: int):
        self.app, self.limit = app, limit

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers", []))
        try:
            length = int(headers.get(b"content-length", b"0"))
        except ValueError:
            length = self.limit + 1
        if length > self.limit:
            return await JSONResponse(
                {"code": "upload_too_large", "detail": "Tổng dung lượng ảnh quá lớn."}, status_code=413
            )(scope, receive, send)
        received = 0

        async def bounded_receive():
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.limit:
                    raise HTTPException(413, "Tổng dung lượng ảnh quá lớn.")
            return message

        return await self.app(scope, bounded_receive, send)


def build_core(settings, *, vision=None, store=None, photos=None, clock=None):
    if store is None:
        if settings.storage_backend == "supabase":
            client = create_client(settings.supabase_url, settings.supabase_secret_key)
            store = SupabaseStore(
                client, cooldown=settings.min_punch_interval_seconds, pending_timeout=settings.pending_timeout_seconds
            )
            photos = photos or SupabasePhotos(client)
        else:
            store = SqliteStore(
                settings.data_dir / "attendance.sqlite3",
                cooldown=settings.min_punch_interval_seconds,
                pending_timeout=settings.pending_timeout_seconds,
            )
    photos = photos or LocalPhotos(settings.data_dir / "photos")
    return AttendanceApplication(settings, store, photos, vision or Vision(settings), clock)


def create_app(settings: Settings | None = None, *, vision=None, store=None, photos=None, clock=None):
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(application):
        configure_logging(settings.log_level)
        core = build_core(settings, vision=vision, store=store, photos=photos, clock=clock)
        application.state.core = core
        refresher = None
        try:
            await asyncio.to_thread(core.warm_up)
            logger.info(
                "runtime_ready | engine=%s | storage=%s | employees=%d",
                settings.engine,
                settings.storage_backend,
                len(core.gallery.snapshot().employees),
            )

            async def refresh_gallery():
                while True:
                    await asyncio.sleep(settings.gallery_refresh_seconds)
                    try:
                        await asyncio.to_thread(core.gallery.refresh)
                    except Exception:
                        logger.error("gallery_refresh_failed; stale snapshots fail closed after configured max age")

            refresher = asyncio.create_task(refresh_gallery())
            yield
        finally:
            if refresher is not None:
                refresher.cancel()
                with suppress(asyncio.CancelledError):
                    await refresher
            core.close()

    application = FastAPI(title="Attendly Attendance API", version="0.2.0", lifespan=lifespan)

    @application.exception_handler(AppError)
    async def application_error(request, error: AppError):
        return JSONResponse(
            {
                "code": error.code,
                "detail": error.message,
                **({"image_index": error.image_index} if error.image_index is not None else {}),
            },
            status_code=error.status,
            headers={"Retry-After": "1"} if error.status in {429, 503} else None,
        )

    @application.exception_handler(Exception)
    async def unexpected_error(request, error):
        logger.error("request_failed | type=%s", type(error).__name__)
        return JSONResponse(
            {"code": "internal_error", "detail": "Máy chủ chưa xử lý được yêu cầu. Vui lòng thử lại."}, status_code=500
        )

    @application.middleware("http")
    async def request_headers(request: Request, call_next):
        start = perf_counter()
        response = await call_next(request)
        response.headers.update(
            {
                "X-Content-Type-Options": "nosniff",
                "Cache-Control": "no-store",
                "X-Frame-Options": "DENY",
                "Referrer-Policy": "no-referrer",
            }
        )
        response.headers["Server-Timing"] = f"total;dur={(perf_counter() - start) * 1000:.1f}"
        logger.info(
            "http_completed | method=%s | route=%s | status=%d | duration_ms=%.1f",
            request.method,
            request.scope.get("route").path if request.scope.get("route") else "unknown",
            response.status_code,
            (perf_counter() - start) * 1000,
        )
        return response

    def role(request: Request):
        if not settings.admin_key:
            return "admin"
        value = request.headers.get("authorization", "")
        token = value[7:] if value.startswith("Bearer ") else ""
        if hmac.compare_digest(token.encode(), settings.admin_key.encode()):
            return "admin"
        if settings.kiosk_key and hmac.compare_digest(token.encode(), settings.kiosk_key.encode()):
            return "kiosk"
        raise AppError("authentication_required", "Nhập mã truy cập của trạm để tiếp tục.", 401)

    def admin(current: Annotated[str, Depends(role)]):
        if current != "admin":
            raise AppError("admin_required", "Chỉ quản trị viên được cập nhật hồ sơ khuôn mặt.", 403)

    def core(request: Request):
        return request.app.state.core

    def read_images(files: list[UploadFile]):
        try:
            if not 1 <= len(files) <= 5:
                raise AppError("image_count", "Chọn từ 1 đến 5 ảnh.")
            result = []
            for index, file in enumerate(files):
                filename = Path((file.filename or "").replace("\\", "/")).name[:160]
                if Path(filename).suffix.lower() not in {".jpg", ".jpeg", ".png"} or file.content_type not in {
                    "image/jpeg",
                    "image/png",
                }:
                    raise AppError("image_type", "Chỉ nhận ảnh JPG hoặc PNG.", 415, image_index=index)
                raw = file.file.read(settings.max_upload_bytes + 1)
                if len(raw) > settings.max_upload_bytes:
                    raise AppError("upload_too_large", "Mỗi ảnh được phép tối đa 5 MB.", 413, image_index=index)
                if not raw:
                    raise AppError("empty_image", "Tệp ảnh rỗng.", image_index=index)
                result.append((filename, raw))
            return result
        finally:
            for file in files:
                file.file.close()

    @application.head("/healthz", include_in_schema=False)
    @application.get("/healthz")
    def health():
        return {"status": "ok"}

    def poses(raw: str):
        try:
            if len(raw) > 256:
                raise ValueError("too many poses")
            value = json.loads(raw) if raw else None
            if value is not None and (
                not isinstance(value, list) or len(value) > 5 or any(not isinstance(item, str) for item in value)
            ):
                raise ValueError("invalid poses")
            return value
        except (ValueError, TypeError) as error:
            raise AppError("pose_set", "Danh sách góc khuôn mặt không hợp lệ.") from error

    @application.get("/readyz")
    def ready(current: Annotated[AttendanceApplication, Depends(core)]):
        current.gallery.snapshot()
        current.store.check_health()
        if not current.vision.ready:
            raise AppError("models_unavailable", "Bộ nhận diện chưa sẵn sàng.", 503)
        return {"status": "ready"}

    @application.get("/api/session", response_model=Session)
    def session(current: Annotated[str, Depends(role)]):
        return {"role": current, "authentication_required": bool(settings.admin_key)}

    @application.get("/api/enrollment/policy", dependencies=[Depends(admin)], response_model=QualityPolicy)
    def enrollment_policy():
        return quality_policy(settings)

    @application.post("/api/enrollment/validate", dependencies=[Depends(admin)], response_model=EnrollmentValidation)
    def validate_enrollment(
        current: Annotated[AttendanceApplication, Depends(core)],
        image: Annotated[UploadFile, File()],
        consent: Annotated[bool, Form()] = False,
        pose: Annotated[Literal["front", "left", "right", "up", "down"], Form()] = "front",
        reference: Annotated[UploadFile | None, File()] = None,
    ):
        images = read_images([image] + ([reference] if reference else []))
        return current.validate_enrollment(images[0][1], consent, pose, images[1][1] if reference else None)

    @application.get("/api/employees", dependencies=[Depends(role)], response_model=list[EmployeeAttendance])
    def employees(current: Annotated[AttendanceApplication, Depends(core)]):
        return current.employees()

    @application.get("/api/attendance", dependencies=[Depends(role)], response_model=list[EmployeeAttendance])
    def attendance(current: Annotated[AttendanceApplication, Depends(core)], date: Date | None = None):
        return current.employees(date.isoformat() if date else None)

    @application.post("/api/employees", status_code=201, dependencies=[Depends(admin)], response_model=EmployeeCreated)
    def enroll(
        current: Annotated[AttendanceApplication, Depends(core)],
        name: Annotated[str, Form()],
        image: Annotated[list[UploadFile], File()],
        consent: Annotated[bool, Form()] = False,
        capture_mode: Annotated[Literal["upload", "guided"], Form()] = "upload",
        pose_labels: Annotated[str, Form()] = "",
    ):
        return current.enroll(
            name, read_images(image), consent, capture_mode=capture_mode, pose_labels=poses(pose_labels)
        )

    @application.put("/api/employees/{employee_id}/face", dependencies=[Depends(admin)], response_model=EmployeeCreated)
    def reenroll(
        employee_id: str,
        current: Annotated[AttendanceApplication, Depends(core)],
        name: Annotated[str, Form()],
        image: Annotated[list[UploadFile], File()],
        consent: Annotated[bool, Form()] = False,
        capture_mode: Annotated[Literal["upload", "guided"], Form()] = "upload",
        pose_labels: Annotated[str, Form()] = "",
    ):
        return current.enroll(
            name, read_images(image), consent, employee_id, capture_mode=capture_mode, pose_labels=poses(pose_labels)
        )

    @application.post("/api/recognize", dependencies=[Depends(role)], response_model=RecognitionResponse)
    def recognize(
        current: Annotated[AttendanceApplication, Depends(core)],
        image: Annotated[UploadFile, File()],
        request_id: Annotated[UUID, Form()],
        action: Annotated[Literal["auto", "in", "out"], Form()] = "auto",
    ):
        return current.recognize(read_images([image])[0][1], str(request_id), action)

    @application.get(
        "/api/recognition-requests/{request_id}",
        dependencies=[Depends(role)],
        response_model=RecognitionResponse | PendingRequest,
    )
    def receipt(request_id: UUID, current: Annotated[AttendanceApplication, Depends(core)]):
        return current.request_status(str(request_id)) or {"request_id": str(request_id), "status": "not_found"}

    application.add_middleware(BodyLimit, limit=settings.max_upload_bytes * 5 + 1024 * 1024)
    application.add_middleware(
        CORSMiddleware,
        allow_origins=list(settings.cors_origins),
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type"],
    )
    return application


app = create_app()
