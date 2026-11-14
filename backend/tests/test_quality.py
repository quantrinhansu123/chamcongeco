"""Quality parity, resize regression and preservation of raw biometric inputs."""

from dataclasses import replace
import json
from pathlib import Path
from unittest.mock import Mock

import cv2
import numpy as np
import pytest

from backend.runtime.errors import AppError
from backend.runtime.quality import check_quality, pixel_metrics
from backend.runtime.settings import Settings
from backend.runtime.vision import Vision


def test_shared_cross_language_golden_pixels():
    fixture = json.loads((Path(__file__).resolve().parents[2] / "tools/face-quality-fixtures.json").read_text())
    n = fixture["size"]
    y, x = np.indices((n, n))
    patterns = {
        "flat": np.full((n, n), 120),
        "color": np.broadcast_to(np.array([100, 150, 200]), (n, n, 3)),
        "checker": np.where((x + y) % 2, 80, 40),
        "ramp": 64 + x,
        "step": np.where(x < n // 2, 80, 180),
    }
    for case in fixture["cases"]:
        rgb = patterns[case["kind"]]
        if rgb.ndim == 2:
            rgb = np.repeat(rgb[:, :, None], 3, axis=2)
        actual = pixel_metrics(rgb.astype(np.uint8))
        assert actual["brightness"] == pytest.approx(case["brightness"], abs=1e-6)
        assert actual["sharpness"] == pytest.approx(case["sharpness"], abs=1e-6)


def textured_face():
    y, x = np.indices((128, 128))
    gray = np.clip(128 + 60 * np.sin(x * 2 * np.pi / 12) + 30 * np.sin(y * 2 * np.pi / 24), 0, 255).astype(np.uint8)
    return np.repeat(gray[:, :, None], 3, axis=2)


def test_scale_alone_cannot_make_a_clear_crop_fail_native_laplacian():
    small = textured_face()
    large = cv2.resize(small, (256, 256), interpolation=cv2.INTER_LINEAR)
    # Reproduce the old resolution-dependent false rejection.
    assert cv2.Laplacian(cv2.cvtColor(large, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var() < 40
    for image in (small, large):
        assert check_quality(image, Settings())["sharpness"] > 40
    blurred = cv2.GaussianBlur(large, (0, 0), 9)
    with pytest.raises(AppError, match="Ảnh đang mờ"):
        check_quality(blurred, Settings())


@pytest.mark.parametrize("value,code", [(15, "face_dark"), (245, "face_bright"), (120, "face_blurry")])
def test_flat_dark_bright_blurry_crops_fail(value, code):
    with pytest.raises(AppError) as error:
        check_quality(np.full((160, 160, 3), value, np.uint8), Settings())
    assert error.value.code == code


def test_policy_overrides_apply_and_invalid_limits_fail():
    assert check_quality(textured_face(), replace(Settings(), min_sharpness=10))["policy_version"] == "face-quality-v2"
    with pytest.raises(AppError) as error:
        check_quality(textured_face(), replace(Settings(), min_sharpness=10000))
    assert error.value.code == "face_blurry"
    for changes in ({"min_brightness": float("nan")}, {"max_brightness": 256}, {"min_brightness": 220}):
        with pytest.raises(ValueError):
            replace(Settings(), **changes)


def test_pad_and_embedding_receive_unfiltered_original_pixels():
    vision = Vision(Settings())
    vision.ready = True
    image = textured_face()
    raw = cv2.imencode(".png", image)[1].tobytes()
    vision._detect = Mock(return_value=[(np.array([0, 0, 128, 128]), None)])

    def check_original(actual, *_):
        np.testing.assert_array_equal(actual, image)
        return 1.0

    vision.liveness_score = Mock(side_effect=check_original)
    vision._embedding = Mock(side_effect=lambda actual, *_: (check_original(actual), np.ones(512))[1])
    result = vision.analyze(raw)
    assert result.quality["sharpness"] > 40
    assert vision.liveness_score.call_count == vision._embedding.call_count == 1
    np.testing.assert_array_equal(result.image, image)
