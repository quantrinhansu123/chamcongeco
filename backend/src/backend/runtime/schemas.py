"""Public HTTP contracts. Biometric profiles and internal photo paths stay private."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict


class PublicModel(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class EmployeeAttendance(PublicModel):
    employee_id: str
    name: str
    is_arrive: bool
    arrived_at: datetime | None
    departed_at: datetime | None
    requires_reenrollment: bool


class EmployeeCreated(PublicModel):
    employee_id: str
    name: str
    image_filename: str
    template_count: int


class Location(PublicModel):
    top: int
    right: int
    bottom: int
    left: int


class RecognizedFace(PublicModel):
    employee_id: str | None
    name: str
    distance: float | None
    location: Location


class RecognitionResponse(PublicModel):
    faces: list[RecognizedFace]
    attendance_updated: list[str]
    attendance: list[EmployeeAttendance]
    request_id: str
    status: Literal["confirmed", "unmatched"]
    action: Literal["in", "out"] | None
    replayed: bool


class PendingRequest(PublicModel):
    request_id: str
    status: Literal["pending", "abandoned", "not_found"]


class Session(PublicModel):
    role: Literal["admin", "kiosk"]
    authentication_required: bool


class QualityPolicy(PublicModel):
    version: Literal["face-quality-v2"]
    crop_size: Literal[128]
    min_sharpness: float
    min_brightness: float
    max_brightness: float
    min_face_pixels: int


class ImageQuality(PublicModel):
    brightness: float
    sharpness: float
    face_pixels: int
    policy_version: Literal["face-quality-v2"]


class EnrollmentValidation(PublicModel):
    valid: Literal[True]
    pose: Literal["front", "left", "right", "up", "down"]
    reference_checked: bool
    quality: ImageQuality | None
