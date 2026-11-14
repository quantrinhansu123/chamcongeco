"""Real CPU ONNX/preflight quality regression, isolated temporary SQLite.

Use public developer images only. This is not a physical camera or accuracy test.
No employee data/model weights are exported. Requires downloaded runtime models.
"""

import argparse
from dataclasses import replace
import json
from pathlib import Path
import tempfile
from time import perf_counter

import cv2
from fastapi.testclient import TestClient
import numpy as np

from backend.runtime.app import create_app
from backend.runtime.settings import Settings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, type=Path)
    parser.add_argument("--other", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    image = cv2.imdecode(np.frombuffer(args.image.read_bytes(), np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        parser.error("image is not decodable")
    raw = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 90])[1].tobytes()
    with tempfile.TemporaryDirectory(prefix="attendly-preflight-") as folder:
        settings = replace(Settings(), data_dir=Path(folder), log_level="ERROR")
        app = create_app(settings)
        with TestClient(app) as client:
            policy = client.get("/api/enrollment/policy").json()
            assert policy["version"] == "face-quality-v2"

            def validate(candidate, pose="front", reference=None):
                files = [("image", ("public.jpg", candidate, "image/jpeg"))]
                if reference is not None:
                    files.append(("reference", ("front.jpg", reference, "image/jpeg")))
                start = perf_counter()
                response = client.post("/api/enrollment/validate", data={"consent": "true", "pose": pose}, files=files)
                return response, (perf_counter() - start) * 1000

            timings, cases = [], []
            for scale in (1, 2):
                scaled = cv2.resize(image, None, fx=scale, fy=scale, interpolation=cv2.INTER_LINEAR)
                candidate = cv2.imencode(".jpg", scaled, [cv2.IMWRITE_JPEG_QUALITY, 90])[1].tobytes()
                response, elapsed = validate(candidate)
                assert response.status_code == 200, response.text
                timings.append(elapsed)
                cases.append(dict(scale=scale, status=response.status_code, quality=response.json()["quality"]))
            poses = ["front", "left", "right", "up", "down"]
            for pose in poses:
                response, elapsed = validate(raw, pose, raw if pose != "front" else None)
                assert response.status_code == 200, response.text
                assert response.json()["reference_checked"] == (pose != "front")
                timings.append(elapsed)
            blurred = cv2.GaussianBlur(image, (0, 0), 14)
            response, _ = validate(cv2.imencode(".jpg", blurred)[1].tobytes())
            assert response.status_code == 422, response.text
            assert response.json()["code"] in {"face_blurry", "face_count", "face_alignment"}, response.text
            if args.other:
                response, _ = validate(args.other.read_bytes(), "left", raw)
                assert response.status_code == 422 and response.json()["code"] == "different_faces", response.text
            core = app.state.core
            assert core.store.list_employees() == []
            assert core.store.list_attendance("2026-11-14") == []
            assert not list(Path(folder).rglob("*.jpg"))
            # Identical public image only verifies API contracts, not actual five-pose accuracy.
            response = client.post(
                "/api/employees",
                data={
                    "name": "Synthetic Preflight",
                    "consent": "true",
                    "capture_mode": "guided",
                    "pose_labels": json.dumps(poses),
                },
                files=[("image", (f"{pose}.jpg", raw, "image/jpeg")) for pose in poses],
            )
            assert response.status_code == 201 and response.json()["template_count"] == 5, response.text
            assert len(core.store.list_employees()) == 1
            result = dict(
                scope="real CPU ONNX via ASGI TestClient, temporary SQLite; public static fixtures only",
                policy=policy,
                scale_regression=cases,
                preflight_samples=len(timings),
                preflight_p50_ms=round(float(np.median(timings)), 2),
                preflight_max_ms=round(max(timings), 2),
                preflight_writes=0,
                final_profiles=1,
                blurred_rejected=True,
                wrong_person_rejected=bool(args.other),
                limitations="not FAR/FRR, real five-pose camera, replay validation, GPU or WAN measurement",
            )
            if args.output:
                args.output.write_text(json.dumps(result, indent=2), encoding="utf-8")
            print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
