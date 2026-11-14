import concurrent.futures
from dataclasses import replace
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from uuid import uuid4
from zoneinfo import ZoneInfo

from fastapi.testclient import TestClient
import numpy as np
from PIL import Image

from backend.runtime.app import create_app
from backend.runtime.assets import MODEL_ID
from backend.runtime.errors import AppError
from backend.runtime.gallery import Gallery
from backend.runtime.settings import Settings
from backend.runtime.store import replace_profile
from backend.runtime.vision import Analysis, Face, Vision, align, context_crop, decode


class FakeVision:
    model_id = MODEL_ID
    dimensions = 512
    ready = True

    def __init__(self):
        self.count = 1
        self.spoof = False
        self.vector = np.eye(1, 512, dtype=np.float32).ravel()
        self.calls = 0
        self.color = 120

    def warm_up(self):
        self.ready = True

    def analyze(self, raw, *, liveness=True):
        self.calls += 1
        if self.spoof and liveness:
            raise AppError("spoof_detected", "Chưa xác minh được khuôn mặt thật.", 403)
        image = np.full((192, 192, 3), self.color, dtype=np.uint8)
        return Analysis(image, tuple(Face((10, 180, 180, 10), self.vector.copy()) for _ in range(self.count)), {})


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.settings = Settings(data_dir=Path(self.temp.name))
        self.now = datetime(2026, 11, 14, 8, 30, tzinfo=ZoneInfo(self.settings.timezone))
        self.vision = FakeVision()
        self.client = self.start()

    def start(self, settings=None):
        client = TestClient(create_app(settings or self.settings, vision=self.vision, clock=lambda: self.now))
        client.__enter__()
        return client

    def tearDown(self):
        self.client.__exit__(None, None, None)
        self.temp.cleanup()

    def enroll(self, name="  Nguyễn   Kiểm Thử ", consent="true", count=1):
        return self.client.post(
            "/api/employees",
            data={"name": name, "consent": consent},
            files=[("image", (f"test{i}.jpg", b"fake", "image/jpeg")) for i in range(count)],
        )

    def punch(self, request_id=None, action="auto", client=None):
        return (client or self.client).post(
            "/api/recognize",
            data={"request_id": str(request_id or uuid4()), "action": action},
            files={"image": ("frame.jpg", b"fake", "image/jpeg")},
        )

    def test_uptime_probe_supports_get_and_head_without_database_or_inference(self):
        core = self.client.app.state.core
        with patch.object(core.store, "check_health", side_effect=AssertionError("Liveness must not query storage")):
            get = self.client.get("/healthz")
            head = self.client.head("/healthz", headers={"User-Agent": "UptimeRobot/2.0"})
        self.assertEqual(get.status_code, 200)
        self.assertEqual(get.json(), {"status": "ok"})
        self.assertEqual(head.status_code, 200)
        self.assertEqual(head.content, b"")
        self.assertEqual(head.headers["content-length"], get.headers["content-length"])
        self.assertEqual(self.vision.calls, 0)

    def test_complete_flow_uses_receipt_and_preserves_first_times(self):
        self.assertEqual(self.enroll(count=3).status_code, 201)
        key = str(uuid4())
        arrival = self.punch(key)
        self.assertEqual(arrival.status_code, 200, arrival.text)
        first = arrival.json()["attendance"][0]
        self.assertTrue(first["is_arrive"])
        self.assertEqual(first["arrived_at"], self.now.isoformat())
        self.assertIsNone(first["departed_at"])
        self.now += timedelta(hours=8)
        replay = self.punch(key).json()
        self.assertEqual(replay["attendance"][0], first)
        self.assertTrue(replay["replayed"])
        checkout = self.punch().json()["attendance"][0]
        self.assertEqual(checkout["arrived_at"], first["arrived_at"])
        self.assertEqual(checkout["departed_at"], self.now.isoformat())
        self.now += timedelta(hours=1)
        self.assertEqual(self.punch().json()["attendance"][0], checkout)
        self.assertEqual(len(list(self.settings.data_dir.rglob("*.jpg"))), 2)

    def test_guided_enrollment_requires_all_named_poses_and_consent(self):
        import json

        poses = ["front", "left", "right", "up", "down"]

        def submit(count=5, labels=poses, consent="true"):
            return self.client.post(
                "/api/employees",
                data={
                    "name": "Guided Synthetic",
                    "consent": consent,
                    "capture_mode": "guided",
                    "pose_labels": json.dumps(labels),
                },
                files=[("image", (f"{i}.jpg", b"fake", "image/jpeg")) for i in range(count)],
            )

        self.assertEqual(submit(4).json()["code"], "pose_set")
        self.assertEqual(submit(labels=["front"] * 5).json()["code"], "pose_set")
        self.assertEqual(submit(consent="false").json()["code"], "consent_required")
        self.assertEqual(self.client.app.state.core.store.list_employees(), [])
        self.assertEqual(submit().json()["template_count"], 5)

    def test_guided_error_identifies_bad_image_and_never_writes_partial_profile(self):
        import json

        original = self.vision.analyze
        calls = []

        def analyze(raw, **kwargs):
            calls.append(raw)
            if len(calls) == 3:
                raise AppError("face_blurry", "Ảnh đang mờ.")
            return original(raw, **kwargs)

        with patch.object(self.vision, "analyze", side_effect=analyze):
            result = self.client.post(
                "/api/employees",
                data={
                    "name": "Guided Synthetic",
                    "consent": "true",
                    "capture_mode": "guided",
                    "pose_labels": json.dumps(["front", "left", "right", "up", "down"]),
                },
                files=[("image", (f"{i}.jpg", b"fake", "image/jpeg")) for i in range(5)],
            )
        self.assertEqual(result.json()["image_index"], 2)
        self.assertEqual(result.json()["code"], "face_blurry")
        self.assertEqual(self.client.app.state.core.store.list_employees(), [])

    def validate_photo(self, *, pose="front", consent="true", raw=b"candidate", reference=None):
        files = [("image", ("candidate.jpg", raw, "image/jpeg"))]
        if reference is not None:
            files.append(("reference", ("front.jpg", reference, "image/jpeg")))
        return self.client.post("/api/enrollment/validate", data={"pose": pose, "consent": consent}, files=files)

    def test_preflight_policy_and_success_are_stateless_without_biometric_leaks(self):
        policy = self.client.get("/api/enrollment/policy").json()
        self.assertEqual(policy["version"], "face-quality-v2")
        self.assertEqual(policy["crop_size"], 128)
        self.assertEqual(policy["min_sharpness"], self.settings.min_sharpness)
        core = self.client.app.state.core
        snapshot = core.gallery.snapshot()
        with patch.object(self.vision, "analyze", wraps=self.vision.analyze) as analyze:
            front = self.validate_photo()
            side = self.validate_photo(pose="left", reference=b"front")
        self.assertEqual(front.status_code, 200, front.text)
        self.assertFalse(front.json()["reference_checked"])
        self.assertEqual(side.json()["pose"], "left")
        self.assertTrue(side.json()["reference_checked"])
        self.assertTrue(all(call.kwargs == {"liveness": False} for call in analyze.call_args_list))
        self.assertEqual(len(analyze.call_args_list), 3)
        self.assertIs(core.gallery.snapshot(), snapshot)
        self.assertEqual(core.store.list_employees(), [])
        self.assertEqual(core.store.list_attendance(self.now.date().isoformat()), [])
        self.assertFalse(list(self.settings.data_dir.rglob("*.jpg")))
        self.assertNotIn("embedding", side.text)
        self.assertNotIn("face_encoding", side.text)

    def test_preflight_requires_consent_reference_and_admin(self):
        before = self.vision.calls
        self.assertEqual(self.validate_photo(consent="false").json()["code"], "consent_required")
        self.assertEqual(self.validate_photo(pose="left").json()["code"], "reference_required")
        self.assertEqual(self.vision.calls, before)
        settings = replace(
            self.settings, data_dir=self.settings.data_dir / "auth", admin_key="a" * 32, kiosk_key="k" * 32
        )
        with TestClient(create_app(settings, vision=self.vision)) as client:
            for key, status in [(None, 401), ("k" * 32, 403), ("a" * 32, 200)]:
                headers = {"Authorization": "Bearer " + key} if key else {}
                self.assertEqual(client.get("/api/enrollment/policy", headers=headers).status_code, status)
                response = client.post(
                    "/api/enrollment/validate",
                    headers=headers,
                    data={"consent": "true"},
                    files={"image": ("a.jpg", b"fake", "image/jpeg")},
                )
                self.assertEqual(response.status_code, status)

    def test_preflight_rejects_quality_and_wrong_identity_before_counting_sample(self):
        with patch.object(self.vision, "analyze", side_effect=AppError("face_blurry", "Ảnh đang mờ.")):
            self.assertEqual(self.validate_photo().json()["code"], "face_blurry")
        original = self.vision.analyze

        def analyze(raw, **kwargs):
            self.vision.vector = np.eye(1, 512, k=1 if raw == b"other" else 0, dtype=np.float32).ravel()
            return original(raw, **kwargs)

        with patch.object(self.vision, "analyze", side_effect=analyze):
            result = self.validate_photo(pose="right", raw=b"other", reference=b"front")
            self.assertEqual(result.json()["code"], "different_faces")
            # Retaking front must compare too, otherwise the other slots become stale.
            self.assertEqual(self.validate_photo(raw=b"other", reference=b"front").json()["code"], "different_faces")
        self.assertEqual(self.client.app.state.core.store.list_employees(), [])
        self.assertEqual(self.validate_photo().status_code, 200)

    def test_preflight_has_bounded_concurrency_and_releases_lock_after_failure(self):
        core = self.client.app.state.core
        core._preflight_lock.acquire()
        try:
            response = self.validate_photo()
            self.assertEqual(response.status_code, 429)
            self.assertEqual(response.headers["Retry-After"], "1")
        finally:
            core._preflight_lock.release()
        with patch.object(self.vision, "analyze", side_effect=AppError("face_blurry", "Ảnh đang mờ.")):
            self.assertEqual(self.validate_photo().status_code, 422)
        self.assertEqual(self.validate_photo().status_code, 200)

    def test_final_save_revalidates_even_after_successful_preflight(self):
        self.assertEqual(self.validate_photo().status_code, 200)
        with patch.object(self.vision, "analyze", side_effect=AppError("face_blurry", "Ảnh đang mờ.")):
            self.assertEqual(self.enroll().json()["code"], "face_blurry")
        self.assertEqual(self.client.app.state.core.store.list_employees(), [])

    def test_preflight_invalid_reference_requires_restart_and_releases_inference(self):
        original = self.vision.analyze

        def analyze(raw, **kwargs):
            if raw == b"bad-reference":
                raise AppError("face_blurry", "Ảnh đang mờ.")
            return original(raw, **kwargs)

        with patch.object(self.vision, "analyze", side_effect=analyze):
            result = self.validate_photo(pose="left", reference=b"bad-reference")
        self.assertEqual(result.json()["code"], "reference_invalid")
        self.assertEqual(self.validate_photo().status_code, 200)
        self.assertEqual(self.client.app.state.core.store.list_employees(), [])

    def test_enrollment_identity_switch_returns_index_and_no_partial_profile(self):
        original = self.vision.analyze
        calls = []

        def analyze(raw, **kwargs):
            calls.append(raw)
            if len(calls) == 2:
                self.vision.vector = np.eye(1, 512, k=1, dtype=np.float32).ravel()
            return original(raw, **kwargs)

        with patch.object(self.vision, "analyze", side_effect=analyze):
            result = self.enroll(count=3)
        self.assertEqual(result.json()["code"], "different_faces")
        self.assertEqual(result.json()["image_index"], 1)
        self.assertEqual(self.client.app.state.core.store.list_employees(), [])

    def test_duplicate_click_does_not_immediately_check_out(self):
        self.enroll()
        self.punch()
        self.now += timedelta(seconds=1)
        result = self.punch().json()
        self.assertIsNone(result["attendance"][0]["departed_at"])
        self.assertEqual(result["attendance_updated"], [])
        self.assertEqual(len(list(self.settings.data_dir.rglob("*.jpg"))), 1)

    def test_receipt_survives_restart_and_skips_model(self):
        self.enroll()
        key = str(uuid4())
        first = self.punch(key).json()
        self.client.__exit__(None, None, None)
        self.client = self.start()
        self.vision.spoof = True
        before = self.vision.calls
        replay = self.punch(key)
        self.assertEqual(replay.status_code, 200)
        self.assertEqual(replay.json()["attendance"], first["attendance"])
        self.assertEqual(self.vision.calls, before)

    def test_spoof_does_not_create_pending_or_attendance(self):
        self.enroll()
        self.vision.spoof = True
        self.assertEqual(self.punch().status_code, 403)
        core = self.client.app.state.core
        with core.store.connection() as db:
            self.assertEqual(db.execute("SELECT count(*) FROM punch_requests").fetchone()[0], 0)
        self.assertFalse(self.client.get("/api/employees").json()[0]["is_arrive"])

    def test_no_face_unknown_and_multiple_faces_do_not_write(self):
        self.enroll()
        self.vision.count = 0
        self.assertEqual(self.punch().json()["status"], "unmatched")
        self.vision.count = 2
        self.assertEqual(self.punch().status_code, 422)
        self.vision.count = 1
        self.vision.vector = np.roll(self.vision.vector, 1)
        self.assertEqual(self.punch().json()["status"], "unmatched")
        self.assertFalse(self.client.get("/api/employees").json()[0]["is_arrive"])

    def test_photo_failure_keeps_pending_and_retry_finishes_once(self):
        self.enroll()
        key = str(uuid4())
        photos = self.client.app.state.core.photos
        with patch.object(photos, "save", side_effect=AppError("storage_unavailable", "Unavailable", 503)):
            self.assertEqual(self.punch(key).status_code, 503)
        self.assertEqual(self.client.get(f"/api/recognition-requests/{key}").json()["status"], "pending")
        self.assertFalse(self.client.get("/api/employees").json()[0]["is_arrive"])
        self.assertEqual(self.punch(key).json()["status"], "confirmed")
        self.assertEqual(len(list(self.settings.data_dir.rglob("*.jpg"))), 1)

    def test_db_failure_after_photo_does_not_replace_evidence_on_retry(self):
        self.enroll()
        key = str(uuid4())
        store = self.client.app.state.core.store
        with patch.object(store, "complete", side_effect=AppError("storage_unavailable", "Unavailable", 503)):
            self.assertEqual(self.punch(key).status_code, 503)
        path = next(self.settings.data_dir.rglob("*.jpg"))
        original = path.read_bytes()
        self.vision.color = 20
        self.assertEqual(self.punch(key).json()["status"], "confirmed")
        self.assertEqual(path.read_bytes(), original)

    def test_concurrent_distinct_intents_do_not_turn_arrival_into_departure(self):
        self.enroll()

        def call(_):
            return self.punch().status_code

        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            results = list(pool.map(call, range(8)))
        self.assertTrue(all(code in (200, 409) for code in results), results)
        row = self.client.get("/api/employees").json()[0]
        self.assertTrue(row["is_arrive"])
        self.assertIsNone(row["departed_at"])

    def test_expired_pending_is_abandoned_and_late_completion_rejected(self):
        self.enroll()
        first_id, second_id = str(uuid4()), str(uuid4())
        store = self.client.app.state.core.store
        context = {"faces": [], "distance": 0.1}
        first = store.reserve(first_id, "emp_001", "auto", self.now, MODEL_ID, context)
        self.now += timedelta(seconds=121)
        store.reserve(second_id, "emp_001", "auto", self.now, MODEL_ID, context)
        self.assertEqual(first["status"], "pending")
        with self.assertRaises(AppError):
            store.complete(first_id, "photo")

    def test_require_consent_uuid_and_valid_upload(self):
        self.assertEqual(self.enroll(consent="false").status_code, 422)
        self.assertEqual(self.enroll(count=6).status_code, 422)
        self.assertEqual(
            self.client.post("/api/recognize", files={"image": ("a.jpg", b"a", "image/jpeg")}).status_code, 422
        )
        self.assertEqual(
            self.client.post(
                "/api/employees",
                data={"name": "X", "consent": "true"},
                files={"image": ("x.svg", b"x", "image/svg+xml")},
            ).status_code,
            415,
        )

    def test_no_vectors_or_keys_in_public_response(self):
        self.enroll()
        response = self.client.get("/api/employees")
        self.assertEqual(response.json()[0]["name"], "Nguyễn Kiểm Thử")
        for forbidden in ("face_encoding", "face_templates", "face_profiles", "API_KEY"):
            self.assertNotIn(forbidden, response.text)
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_gallery_cached_on_punch_and_list_paths(self):
        self.enroll()
        with patch.object(
            self.client.app.state.core.store,
            "list_employees",
            side_effect=AssertionError("gallery fetched during request"),
        ):
            self.assertEqual(self.punch().status_code, 200)
            self.assertEqual(self.client.get("/api/employees").status_code, 200)

    def test_kiosk_cannot_enroll_but_can_list_and_punch(self):
        self.client.__exit__(None, None, None)
        admin, kiosk = "a" * 32, "k" * 32
        self.client = self.start(replace(self.settings, admin_key=admin, kiosk_key=kiosk))
        self.assertEqual(self.client.get("/api/employees").status_code, 401)
        self.client.headers["Authorization"] = "Bearer " + kiosk
        self.assertEqual(self.client.get("/api/session").json()["role"], "kiosk")
        self.assertEqual(self.enroll().status_code, 403)
        self.assertEqual(self.client.get("/api/employees").status_code, 200)
        self.client.headers["Authorization"] = "Bearer " + admin
        self.assertEqual(self.enroll().status_code, 201)

    def test_expired_same_intent_is_abandoned_before_reopening_camera(self):
        self.enroll()
        request_id = str(uuid4())
        with patch.object(
            self.client.app.state.core.photos, "save", side_effect=AppError("storage_unavailable", "Unavailable", 503)
        ):
            self.assertEqual(self.punch(request_id).status_code, 503)
        self.now += timedelta(seconds=121)
        status = self.client.get(f"/api/recognition-requests/{request_id}")
        self.assertEqual(status.json()["status"], "abandoned")
        self.assertEqual(self.punch(request_id).json()["code"], "request_expired")
        self.assertEqual(self.client.app.state.core.store.list_attendance(self.now.date().isoformat()), [])

    def test_streamed_or_declared_oversize_body_is_rejected(self):
        # No Content-Length: the streaming guard must still enforce the budget.
        from backend.runtime.app import BodyLimit
        import asyncio

        async def probe():
            sent = []

            async def downstream(scope, receive, send):
                while True:
                    message = await receive()
                    if not message.get("more_body"):
                        break

            async def receive():
                return {"type": "http.request", "body": b"12345", "more_body": True}

            async def send(message):
                sent.append(message)

            with self.assertRaises(Exception) as caught:
                await BodyLimit(downstream, 8)({"type": "http", "headers": []}, receive, send)
            self.assertEqual(caught.exception.status_code, 413)
            await BodyLimit(downstream, 8)({"type": "http", "headers": [(b"content-length", b"9")]}, receive, send)
            self.assertEqual(sent[0]["status"], 413)

        asyncio.run(probe())

    def test_update_face_preserves_attendance_and_legacy_profile(self):
        core = self.client.app.state.core
        core.store.create_employee(
            dict(
                employee_id="emp_010",
                name="Hồ sơ cũ",
                image_filename="old.jpg",
                created_at=self.now.isoformat(),
                face_encoding=[0.1] * 128,
                face_model="dlib-v1",
            )
        )
        core.gallery.refresh()
        self.assertTrue(self.client.get("/api/employees").json()[0]["requires_reenrollment"])
        result = self.client.put(
            "/api/employees/emp_010/face",
            data={"name": "Hồ sơ cũ", "consent": "true"},
            files={"image": ("new.jpg", b"fake", "image/jpeg")},
        )
        self.assertEqual(result.status_code, 200, result.text)
        record = core.store.list_employees()[0]
        self.assertEqual(len(record["face_profiles"]["dlib-v1"][0]), 128)
        self.assertEqual(len(record["face_profiles"][MODEL_ID][0]), 512)
        self.assertFalse(self.client.get("/api/employees").json()[0]["requires_reenrollment"])

    def test_checkout_requires_arrival_and_midnight_starts_new_day(self):
        self.enroll()
        self.assertEqual(self.punch(action="out").status_code, 422)
        self.punch()
        self.now += timedelta(days=1)
        self.assertIsNone(self.punch().json()["attendance"][0]["departed_at"])


class GalleryAndVisionTests(unittest.TestCase):
    def test_margin_compares_people_not_templates(self):
        v = FakeVision()
        e = replace_profile(
            {"employee_id": "emp_001", "name": "Synthetic"},
            {"face_model": MODEL_ID, "face_templates": [v.vector.tolist()] * 5, "face_encoding": v.vector.tolist()},
        )

        class Store:
            def list_employees(self):
                return [e]

        gallery = Gallery(Store(), v)
        gallery.refresh()
        self.assertEqual(gallery.match(v.vector, threshold=0.5, margin=0.08)[0], "emp_001")
        with self.assertRaises(ValueError):
            gallery.snapshot().matrix[0, 0] = 0
        gallery._snapshot = replace(gallery.snapshot(), refreshed_at=-1000)
        with self.assertRaises(AppError):
            gallery.snapshot()

    def test_decoder_rejects_invalid_or_excessive_dimensions(self):
        with self.assertRaises(AppError):
            decode(b"not an image", 1000)
        stream = BytesIO()
        Image.new("RGB", (100, 100)).save(stream, format="PNG")
        with self.assertRaises(AppError):
            decode(stream.getvalue(), 9999)

    def test_busy_inference_fails_bounded_and_alignment_rejects_bad_points(self):
        vision = Vision(Settings())
        vision.ready = True
        vision._lock.acquire()
        try:
            with self.assertRaises(AppError) as caught:
                vision.analyze(b"unused")
            self.assertEqual(caught.exception.status, 429)
        finally:
            vision._lock.release()
        with self.assertRaises(AppError):
            align(np.zeros((200, 200, 3), np.uint8), np.zeros((5, 2)))

    def test_context_crop_keeps_edge_faces_inside_image(self):
        image = np.arange(100 * 100 * 3, dtype=np.uint8).reshape(100, 100, 3)
        self.assertEqual(context_crop(image, np.array([0, 0, 50, 50]), 4).shape, (80, 80, 3))

    def test_production_requires_strong_distinct_keys(self):
        with self.assertRaises(ValueError):
            Settings(environment="production")
        with self.assertRaises(ValueError):
            Settings(admin_key="x" * 32, kiosk_key="x" * 32)


if __name__ == "__main__":
    unittest.main()
