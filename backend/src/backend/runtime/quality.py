"""Resolution-normalized, unfiltered face quality shared with the camera worker.

The server publishes the policy; browser checks remain advisory because mesh and
SCRFD crops/JPEG sampling differ. Preflight and final save use this same gate.
"""

import cv2
import numpy as np

from .errors import AppError

QUALITY_VERSION = "face-quality-v2"
CROP_SIZE = 128


def quality_policy(settings):
    return dict(
        version=QUALITY_VERSION,
        crop_size=CROP_SIZE,
        min_sharpness=settings.min_sharpness,
        min_brightness=settings.min_brightness,
        max_brightness=settings.max_brightness,
        min_face_pixels=settings.min_face_pixels,
    )


def pixel_metrics(rgb):
    """Same float luminance and interior 4-neighbour kernel as quality.ts."""
    rgb = np.asarray(rgb, dtype=np.float64)
    # JS evaluates luminance in double, writes Float32Array, then evaluates
    # the Laplacian and accumulators in double. Preserve those same steps.
    gray = (rgb[:, :, 0] * 0.299 + rgb[:, :, 1] * 0.587 + rgb[:, :, 2] * 0.114).astype(np.float32).astype(np.float64)
    lap = gray[1:-1, :-2] + gray[1:-1, 2:] + gray[:-2, 1:-1] + gray[2:, 1:-1] - 4 * gray[1:-1, 1:-1]
    return dict(brightness=float(gray.mean(dtype=np.float64)), sharpness=float(lap.var(dtype=np.float64)))


def check_quality(roi, settings):
    pixels = min(roi.shape[:2])
    if pixels < settings.min_face_pixels:
        raise AppError("face_too_small", "Hãy đưa khuôn mặt gần camera hơn.")
    normalized = cv2.resize(roi, (CROP_SIZE, CROP_SIZE), interpolation=cv2.INTER_LINEAR)
    metrics = pixel_metrics(cv2.cvtColor(normalized, cv2.COLOR_BGR2RGB))
    if metrics["brightness"] < settings.min_brightness:
        raise AppError("face_dark", "Khuôn mặt đang tối. Hãy bổ sung ánh sáng phía trước.")
    if metrics["brightness"] > settings.max_brightness:
        raise AppError("face_bright", "Ánh sáng đang quá gắt. Hãy tránh nguồn sáng chiếu thẳng.")
    if metrics["sharpness"] < settings.min_sharpness:
        raise AppError("face_blurry", "Ảnh đang mờ. Giữ yên, bổ sung ánh sáng và kiểm tra ống kính camera.")
    return dict(**metrics, face_pixels=pixels, policy_version=QUALITY_VERSION)
