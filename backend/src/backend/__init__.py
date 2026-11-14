"""Core face recognition package."""

from backend.config import Settings
__all__ = ["FaceEncoder", "FaceRecognizer", "Settings"]


def __getattr__(name: str):
    # Legacy support is optional; importing configuration must not load dlib.
    if name == "FaceEncoder":
        from backend.services.face_encoder import FaceEncoder
        return FaceEncoder
    if name == "FaceRecognizer":
        from backend.services.face_recognizer import FaceRecognizer
        return FaceRecognizer
    raise AttributeError(name)
