"""Face encoding and recognition services."""

from importlib import import_module

_EXPORTS = {
    'AttendanceService': 'attendance_service', 'FaceEncoder': 'face_encoder',
    'FaceLivenessDetector': 'face_liveness', 'FaceRecognizer': 'face_recognizer',
    'EmployeeService': 'employee_service', 'RecognitionService': 'recognition_service',
}


def __getattr__(name):
    if name in _EXPORTS:
        return getattr(import_module('backend.services.' + _EXPORTS[name]), name)
    raise AttributeError(name)

__all__ = [
    "AttendanceService",
    "EmployeeService",
    "FaceEncoder",
    "FaceLivenessDetector",
    "FaceRecognizer",
    "RecognitionService",
]
