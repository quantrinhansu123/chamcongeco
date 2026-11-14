"""CPU ONNX inference, one decode/detector per frame, no network calls.

SCRFD decode/alignment follows InsightFace (Jia Guo, MIT); MiniFASNet context
cropping follows MiniVision (Apache-2.0). See THIRD_PARTY_NOTICES.md.
"""

from dataclasses import dataclass
from io import BytesIO
import logging
from threading import Lock
from time import perf_counter
import warnings

import cv2
import numpy as np
from PIL import Image, UnidentifiedImageError

from .assets import ASSETS, LEGACY_MODEL_ID, MODEL_ID, verify
from .errors import AppError
from .quality import check_quality
from .settings import Settings

logger = logging.getLogger(__name__)
ALIGNMENT = np.array(
    [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]],
    dtype=np.float64,
)


@dataclass(frozen=True)
class Face:
    location: tuple[int, int, int, int]
    embedding: np.ndarray | None = None


@dataclass(frozen=True)
class Analysis:
    image: np.ndarray
    faces: tuple[Face, ...]
    stages_ms: dict[str, float]
    quality: dict | None = None

    def jpeg(self) -> bytes:
        image = self.image
        if max(image.shape[:2]) > 1280:
            scale = 1280 / max(image.shape[:2])
            image = cv2.resize(image, None, fx=scale, fy=scale)
        ok, encoded = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 85])
        if not ok:
            raise AppError("image_encoding", "Không tạo được ảnh minh chứng.")
        return encoded.tobytes()


def decode(raw: bytes, max_pixels: int) -> np.ndarray:
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(raw)) as source:
                if source.format not in {"JPEG", "PNG"} or source.width * source.height > max_pixels:
                    raise AppError("image_dimensions", "Ảnh không hợp lệ hoặc có kích thước quá lớn.")
                if min(source.size) < 32:
                    raise AppError("image_dimensions", "Ảnh quá nhỏ để nhận diện.")
                rgb = np.asarray(source.convert("RGB"), dtype=np.uint8)
    except (
        UnidentifiedImageError,
        OSError,
        ValueError,
        Image.DecompressionBombError,
        Image.DecompressionBombWarning,
    ) as error:
        raise AppError("invalid_image", "Không đọc được ảnh JPG/PNG.") from error
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)


def align(image: np.ndarray, points: np.ndarray) -> np.ndarray:
    src = np.asarray(points, dtype=np.float64)
    if src.shape != (5, 2) or not np.isfinite(src).all():
        raise AppError("face_alignment", "Không xác định được các điểm khuôn mặt.")
    src_mean, dst_mean = src.mean(0), ALIGNMENT.mean(0)
    src_center, dst_center = src - src_mean, ALIGNMENT - dst_mean
    variance = np.square(src_center).sum() / 5
    if variance < 1e-8:
        raise AppError("face_alignment", "Hãy nhìn thẳng và giữ rõ khuôn mặt.")
    u, singular, vt = np.linalg.svd(dst_center.T @ src_center / 5)
    signs = np.ones(2)
    if np.linalg.det(u @ vt) < 0:
        signs[-1] = -1
    rotation = (u * signs) @ vt
    scale = (singular * signs).sum() / variance
    affine = np.column_stack((scale * rotation, dst_mean - scale * rotation @ src_mean))
    return cv2.warpAffine(image, affine, (112, 112), borderValue=0)


def context_crop(image: np.ndarray, box: np.ndarray, scale: float) -> np.ndarray:
    height, width = image.shape[:2]
    x, y, w, h = (float(n) for n in box[:4])
    scale = min((height - 1) / max(h, 1), (width - 1) / max(w, 1), scale)
    nw, nh = w * scale, h * scale
    left, top = x + w / 2 - nw / 2, y + h / 2 - nh / 2
    right, bottom = left + nw, top + nh
    if left < 0:
        right -= left
        left = 0
    if top < 0:
        bottom -= top
        top = 0
    if right > width - 1:
        left -= right - width + 1
        right = width - 1
    if bottom > height - 1:
        top -= bottom - height + 1
        bottom = height - 1
    roi = image[max(0, int(top)) : int(bottom) + 1, max(0, int(left)) : int(right) + 1]
    if roi.size == 0:
        raise AppError("face_crop", "Hãy đưa khuôn mặt vào giữa khung hình.")
    return cv2.resize(roi, (80, 80))


class Vision:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.model_id = MODEL_ID if settings.engine == "insightface" else LEGACY_MODEL_ID
        self.dimensions = 512 if settings.engine == "insightface" else 128
        self.ready = False
        self._lock = Lock()

    def warm_up(self):
        import onnxruntime as ort

        verify(self.settings.model_dir)
        cv2.setNumThreads(self.settings.cpu_threads)
        cv2.ocl.setUseOpenCL(False)
        options = ort.SessionOptions()
        options.intra_op_num_threads = self.settings.cpu_threads
        options.inter_op_num_threads = 1
        options.log_severity_level = 3
        options.add_session_config_entry("session.intra_op.allow_spinning", "0")

        def load(name):
            return ort.InferenceSession(
                str(self.settings.model_dir / name), sess_options=options, providers=["CPUExecutionProvider"]
            )

        self.pad = [load(name) for name in list(ASSETS)[2:]]
        if self.settings.engine == "insightface":
            self.detector = load("det_500m.onnx")
            self.recognizer = load("w600k_mbf.onnx")
            self._detect(np.zeros((480, 640, 3), dtype=np.uint8))
            self.recognizer.run(
                None, {self.recognizer.get_inputs()[0].name: np.zeros((1, 3, 112, 112), dtype=np.float32)}
            )
        else:
            import dlib
            import face_recognition_models as models

            self.detector = dlib.get_frontal_face_detector()
            self.predictor = dlib.shape_predictor(models.pose_predictor_five_point_model_location())
            self.recognizer = dlib.face_recognition_model_v1(models.face_recognition_model_location())
        for model in self.pad:
            model.run(None, {model.get_inputs()[0].name: np.zeros((1, 80, 80, 3), dtype=np.float32)})
        self.ready = True

    def _detect(self, image):
        if self.settings.engine == "dlib":
            rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            smaller = cv2.resize(rgb, None, fx=0.5, fy=0.5)
            result = []
            for box in self.detector(smaller, 1):
                x, y, right, bottom = [int(n * 2) for n in (box.left(), box.top(), box.right(), box.bottom())]
                result.append((np.array([x, y, right - x, bottom - y]), None))
            return result
        size = self.settings.detector_size
        ratio = min(size / image.shape[0], size / image.shape[1])
        new_w, new_h = int(image.shape[1] * ratio), int(image.shape[0] * ratio)
        canvas = np.zeros((size, size, 3), dtype=np.uint8)
        canvas[:new_h, :new_w] = cv2.resize(image, (new_w, new_h))
        blob = cv2.dnn.blobFromImage(canvas, 1 / 128, (size, size), (127.5, 127.5, 127.5), swapRB=True)
        outputs = self.detector.run(None, {self.detector.get_inputs()[0].name: blob})
        boxes, scores, points = [], [], []
        scale = new_h / image.shape[0]
        for level, stride in enumerate((8, 16, 32)):
            score = outputs[level].reshape(-1)
            distance = outputs[level + 3].reshape(-1, 4) * stride
            keypoints = outputs[level + 6].reshape(-1, 10) * stride
            centers = (
                np.stack(np.mgrid[: size // stride, : size // stride][::-1], axis=-1).astype(np.float32).reshape(-1, 2)
                * stride
            )
            centers = np.repeat(centers, 2, axis=0)
            keep = np.where(score >= 0.6)[0]
            if not len(keep):
                continue
            center = centers[keep]
            dist = distance[keep]
            boxes.append(
                np.column_stack(
                    (
                        center[:, 0] - dist[:, 0],
                        center[:, 1] - dist[:, 1],
                        center[:, 0] + dist[:, 2],
                        center[:, 1] + dist[:, 3],
                    )
                )
                / scale
            )
            points.append((keypoints[keep].reshape(-1, 5, 2) + center[:, None, :]) / scale)
            scores.append(score[keep])
        if not boxes:
            return []
        boxes, points, scores = np.vstack(boxes), np.vstack(points), np.concatenate(scores)
        order = np.argsort(-scores, kind="stable")
        chosen = []
        while len(order):
            i = order[0]
            chosen.append(i)
            remaining = order[1:]
            xx1 = np.maximum(boxes[i, :2], boxes[remaining, :2])
            xx2 = np.minimum(boxes[i, 2:], boxes[remaining, 2:])
            overlap = np.prod(np.maximum(0, xx2 - xx1 + 1), axis=1)
            area_i = np.prod(boxes[i, 2:] - boxes[i, :2] + 1)
            area_r = np.prod(boxes[remaining, 2:] - boxes[remaining, :2] + 1, axis=1)
            order = remaining[overlap / (area_i + area_r - overlap) <= 0.4]
        return [
            (np.array([boxes[i, 0], boxes[i, 1], boxes[i, 2] - boxes[i, 0], boxes[i, 3] - boxes[i, 1]]), points[i])
            for i in chosen
        ]

    def _embedding(self, image, box, landmarks):
        if self.settings.engine == "dlib":
            import dlib

            x, y, w, h = (int(n) for n in box)
            rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
            shape = self.predictor(rgb, dlib.rectangle(x, y, x + w, y + h))
            return np.asarray(self.recognizer.compute_face_descriptor(rgb, shape, 1), dtype=np.float64)
        aligned = align(image, landmarks)
        blob = cv2.dnn.blobFromImage(aligned, 1 / 127.5, (112, 112), (127.5, 127.5, 127.5), swapRB=True)
        vector = self.recognizer.run(None, {self.recognizer.get_inputs()[0].name: blob})[0].reshape(-1)
        if vector.shape != (512,) or not np.isfinite(vector).all() or np.linalg.norm(vector) < 1e-8:
            raise AppError("model_output", "Bộ nhận diện chưa sẵn sàng.", 503)
        return vector / np.linalg.norm(vector)

    def analyze(self, raw: bytes, *, liveness: bool = True) -> Analysis:
        if not self.ready:
            raise AppError("models_unavailable", "Bộ nhận diện chưa sẵn sàng.", 503)
        if not self._lock.acquire(timeout=0.05):
            raise AppError("busy", "Trạm đang xử lý. Vui lòng giữ mặt trong khung hình.", 429)
        stages = {}

        def timed(name, operation):
            start = perf_counter()
            result = operation()
            stages[name] = round((perf_counter() - start) * 1000, 2)
            return result

        try:
            image = timed("decode", lambda: decode(raw, self.settings.max_image_pixels))
            detected = timed("detect", lambda: self._detect(image))

            def location(box):
                x, y, w, h = box
                return (
                    max(0, int(y)),
                    min(image.shape[1], int(x + w)),
                    min(image.shape[0], int(y + h)),
                    max(0, int(x)),
                )

            if len(detected) != 1:
                return Analysis(image, tuple(Face(location(box)) for box, _ in detected), stages)
            box, landmarks = detected[0]
            top, right, bottom, left = location(box)
            roi = image[top:bottom, left:right]
            quality = timed("quality", lambda: check_quality(roi, self.settings))
            if liveness:
                score = timed("pad", lambda: self.liveness_score(image, box))
                if score < self.settings.liveness_threshold:
                    raise AppError(
                        "spoof_detected", "Chưa xác minh được khuôn mặt thật. Không dùng ảnh hoặc màn hình.", 403
                    )
            embedding = timed("embedding", lambda: self._embedding(image, box, landmarks))
            return Analysis(image, (Face((top, right, bottom, left), embedding),), stages, quality)
        finally:
            self._lock.release()
            logger.info("vision_completed | stages_ms=%s", stages)

    def liveness_score(self, image, box):
        probabilities = np.zeros(3)
        for model, scale in zip(self.pad, (2.7, 4.0), strict=True):
            crop = context_crop(image, box, scale)
            tensor = np.ascontiguousarray(crop[None], dtype=np.float32)
            out = model.run(None, {model.get_inputs()[0].name: tensor})[0].reshape(-1)
            if (
                out.shape != (3,)
                or not np.isfinite(out).all()
                or np.any(out < 0)
                or np.any(out > 1)
                or abs(out.sum() - 1) > 0.01
            ):
                raise AppError("liveness_unavailable", "Chưa xác minh được khuôn mặt thật.", 503)
            probabilities += out / 2
        return float(probabilities[1]) if np.argmax(probabilities) == 1 else 0.0
