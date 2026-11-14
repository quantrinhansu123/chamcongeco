"""Private evidence. Atomic local writes; Supabase storage never uses public URLs."""

from pathlib import Path
import os
import re
from tempfile import NamedTemporaryFile

import httpx

from .errors import AppError, unavailable

BUCKET = "attendance-photos"


def object_path(request: dict) -> str:
    employee = request["employee_id"]
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", employee):
        raise AppError("invalid_employee_id", "Mã nhân viên không hợp lệ.", 503)
    return f"{request['attendance_date']}/{employee}/{request['action']}/{request['request_id']}.jpg"


class LocalPhotos:
    def __init__(self, root: Path):
        self.root = root.resolve()
        self.root.mkdir(parents=True, exist_ok=True)

    def initialize(self):
        pass

    def save(self, request: dict, image: bytes) -> str:
        relative = object_path(request)
        path = (self.root / relative).resolve()
        if not path.is_relative_to(self.root):
            raise AppError("invalid_photo_path", "Đường dẫn ảnh không hợp lệ.", 503)
        temporary = None
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with NamedTemporaryFile(dir=path.parent, delete=False) as handle:
                temporary = Path(handle.name)
                handle.write(image)
                handle.flush()
                os.fsync(handle.fileno())
            try:
                os.link(temporary, path)
            except FileExistsError:
                pass  # A retry preserves the first evidence frame for this intent.
            if os.name != "nt":
                # Persist the directory entry before acknowledging evidence/DB
                # completion, in addition to fsync of the JPEG contents above.
                directory = os.open(path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
        except OSError as error:
            raise unavailable() from error
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
        return relative

    def close(self):
        pass


class SupabasePhotos:
    def __init__(self, client: httpx.Client):
        self.client = client

    def initialize(self):
        try:
            response = self.client.get(f"/storage/v1/bucket/{BUCKET}")
            missing = response.status_code == 404
            if response.status_code == 400:
                try:
                    error = response.json()
                except ValueError:
                    error = {}
                # Supabase Storage can wrap NoSuchBucket in HTTP 400.
                missing = isinstance(error, dict) and error.get("code") == "NoSuchBucket"
            if missing:
                response = self.client.post(
                    "/storage/v1/bucket",
                    json=dict(
                        id=BUCKET, name=BUCKET, public=False, file_size_limit=5242880, allowed_mime_types=["image/jpeg"]
                    ),
                )
                # Another instance may have created it concurrently.
                if response.status_code in {400, 409}:
                    response = self.client.get(f"/storage/v1/bucket/{BUCKET}")
            response.raise_for_status()
            details = self.client.get(f"/storage/v1/bucket/{BUCKET}")
            details.raise_for_status()
            if details.json().get("public"):
                raise RuntimeError("Attendance evidence bucket must be private")
        except httpx.HTTPError as error:
            raise unavailable() from error

    def save(self, request: dict, image: bytes) -> str:
        relative = object_path(request)
        try:
            response = self.client.post(
                f"/storage/v1/object/{BUCKET}/{relative}",
                content=image,
                headers={"Content-Type": "image/jpeg", "x-upsert": "false"},
                timeout=20,
            )
            body = response.json() if response.headers.get("content-type", "").startswith("application/json") else {}
            if response.status_code == 409 or str(body.get("statusCode")) == "409":
                # Verify that the private object exists; never acknowledge an unverified error.
                existing = self.client.get(f"/storage/v1/object/authenticated/{BUCKET}/{relative}")
                existing.raise_for_status()
            else:
                response.raise_for_status()
        except (httpx.HTTPError, ValueError) as error:
            raise unavailable() from error
        return relative

    def close(self):
        pass
