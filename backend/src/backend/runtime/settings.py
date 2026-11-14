from dataclasses import dataclass, field
import math
import os
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[3]


@dataclass(frozen=True)
class Settings:
    environment: str = "development"
    log_level: str = "INFO"
    storage_backend: str = "sqlite"
    data_dir: Path = field(default_factory=lambda: ROOT / "data" / "runtime")
    model_dir: Path = field(default_factory=lambda: ROOT / "models")
    engine: str = "insightface"
    timezone: str = "Asia/Ho_Chi_Minh"
    cosine_threshold: float = 0.50
    recognition_margin: float = 0.08
    liveness_threshold: float = 0.85
    min_face_pixels: int = 80
    min_sharpness: float = 40.0
    min_brightness: float = 45.0
    max_brightness: float = 220.0
    detector_size: int = 320
    cpu_threads: int = 1
    max_upload_bytes: int = 5 * 1024 * 1024
    max_image_pixels: int = 12_000_000
    gallery_refresh_seconds: float = 30
    gallery_max_age_seconds: float = 120
    min_punch_interval_seconds: int = 30
    pending_timeout_seconds: int = 120
    admin_key: str = ""
    kiosk_key: str = ""
    supabase_url: str = ""
    supabase_secret_key: str = ""
    cors_origins: tuple[str, ...] = ("http://localhost:5173", "http://127.0.0.1:5173")

    def __post_init__(self):
        for name in (
            "min_sharpness",
            "min_brightness",
            "max_brightness",
            "gallery_refresh_seconds",
            "gallery_max_age_seconds",
        ):
            if not math.isfinite(getattr(self, name)):
                raise ValueError(f"{name} must be finite")
        if self.environment not in {"development", "production"}:
            raise ValueError("APP_ENV must be development or production")
        if self.log_level not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
            raise ValueError("FACE_LOG_LEVEL must be DEBUG, INFO, WARNING, ERROR or CRITICAL")
        if self.storage_backend not in {"sqlite", "supabase"}:
            raise ValueError("STORAGE_BACKEND must be sqlite or supabase; import CSV first")
        if self.engine not in {"insightface", "dlib"}:
            raise ValueError("FACE_ENGINE must be insightface or dlib")
        for name in ("cosine_threshold", "recognition_margin", "liveness_threshold"):
            if not 0 < getattr(self, name) < 1:
                raise ValueError(f"{name} must be between 0 and 1")
        if self.detector_size < 160 or self.detector_size > 1280 or self.detector_size % 32:
            raise ValueError("FACE_DETECTOR_SIZE must be 160..1280, divisible by 32")
        if not 1 <= self.cpu_threads <= 16 or self.min_face_pixels < 24 or self.min_sharpness < 0:
            raise ValueError("Invalid vision limits")
        if not 0 <= self.min_brightness < self.max_brightness <= 255:
            raise ValueError("Invalid face brightness range")
        if self.max_upload_bytes < 1 or self.max_image_pixels < 1:
            raise ValueError("Invalid upload limits")
        if not 1 <= self.gallery_refresh_seconds < self.gallery_max_age_seconds:
            raise ValueError("Gallery refresh must be positive and smaller than max age")
        if self.min_punch_interval_seconds < 0 or self.pending_timeout_seconds < 10:
            raise ValueError("Invalid attendance time limits")
        ZoneInfo(self.timezone)
        if self.environment == "production" and len(self.admin_key) < 32:
            raise ValueError("Production requires FACE_ADMIN_API_KEY of at least 32 characters")
        if self.kiosk_key and (len(self.kiosk_key) < 32 or self.kiosk_key == self.admin_key):
            raise ValueError("FACE_KIOSK_API_KEY must be distinct and at least 32 characters")
        if self.admin_key and len(self.admin_key) < 32:
            raise ValueError("FACE_ADMIN_API_KEY must have at least 32 characters")
        if self.kiosk_key and not self.admin_key:
            raise ValueError("Kiosk authentication requires an admin key")
        if any(
            not key.isascii() or any(character.isspace() for character in key)
            for key in (self.admin_key, self.kiosk_key)
        ):
            raise ValueError("API keys must be ASCII without whitespace")
        if "*" in self.cors_origins:
            raise ValueError("Use explicit FACE_CORS_ORIGINS")
        if self.storage_backend == "supabase" and (
            not self.supabase_url.startswith("https://") or not self.supabase_secret_key
        ):
            raise ValueError("Supabase requires an HTTPS URL and server secret key")

    @classmethod
    def from_env(cls):
        from dotenv import load_dotenv

        load_dotenv(ROOT / ".env", override=False)
        d = cls()

        def value(key, default, convert=str):
            return convert(os.environ[key]) if key in os.environ else default

        return cls(
            environment=value("APP_ENV", d.environment),
            log_level=value("FACE_LOG_LEVEL", d.log_level).upper(),
            storage_backend=value("STORAGE_BACKEND", d.storage_backend),
            data_dir=value("FACE_DATA_DIR", d.data_dir, Path),
            model_dir=value("FACE_MODEL_DIR", d.model_dir, Path),
            engine=value("FACE_ENGINE", d.engine),
            timezone=value("FACE_TIMEZONE", d.timezone),
            cosine_threshold=value("FACE_COSINE_THRESHOLD", d.cosine_threshold, float),
            recognition_margin=value("FACE_RECOGNITION_MARGIN", d.recognition_margin, float),
            liveness_threshold=value("FACE_LIVENESS_THRESHOLD", d.liveness_threshold, float),
            min_face_pixels=value("FACE_MIN_FACE_PIXELS", d.min_face_pixels, int),
            min_sharpness=value("FACE_MIN_SHARPNESS", d.min_sharpness, float),
            min_brightness=value("FACE_MIN_BRIGHTNESS", d.min_brightness, float),
            max_brightness=value("FACE_MAX_BRIGHTNESS", d.max_brightness, float),
            detector_size=value("FACE_DETECTOR_SIZE", d.detector_size, int),
            cpu_threads=value("FACE_CPU_THREADS", d.cpu_threads, int),
            max_upload_bytes=value("FACE_MAX_UPLOAD_BYTES", d.max_upload_bytes, int),
            max_image_pixels=value("FACE_MAX_IMAGE_PIXELS", d.max_image_pixels, int),
            gallery_refresh_seconds=value("FACE_GALLERY_REFRESH_SECONDS", d.gallery_refresh_seconds, float),
            gallery_max_age_seconds=value("FACE_GALLERY_MAX_AGE_SECONDS", d.gallery_max_age_seconds, float),
            min_punch_interval_seconds=value("FACE_MIN_PUNCH_INTERVAL_SECONDS", d.min_punch_interval_seconds, int),
            pending_timeout_seconds=value("FACE_PENDING_TIMEOUT_SECONDS", d.pending_timeout_seconds, int),
            admin_key=value("FACE_ADMIN_API_KEY", ""),
            kiosk_key=value("FACE_KIOSK_API_KEY", ""),
            supabase_url=value("SUPABASE_URL", ""),
            supabase_secret_key=value("SUPABASE_SECRET_KEY", ""),
            cors_origins=tuple(
                x.strip() for x in value("FACE_CORS_ORIGINS", ",".join(d.cors_origins)).split(",") if x.strip()
            ),
        )
