from datetime import datetime
import unittest
from uuid import uuid4

import httpx

from backend.runtime.errors import AppError
from backend.runtime.photos import BUCKET, SupabasePhotos
from backend.runtime.supabase import SupabaseStore


class TransportTests(unittest.TestCase):
    def client(self, handler):
        client = httpx.Client(
            base_url="https://synthetic.supabase.co",
            headers={"apikey": "synthetic-secret", "Authorization": "Bearer synthetic-secret"},
            transport=httpx.MockTransport(handler),
        )
        self.addCleanup(client.close)
        return client

    def test_write_timeout_is_not_automatically_retried_or_leaked(self):
        calls = []

        def handler(request):
            calls.append(request)
            raise httpx.ReadTimeout("sensitive remote diagnostic", request=request)

        store = SupabaseStore(self.client(handler))
        with self.assertRaises(AppError) as result:
            store.reserve(
                str(uuid4()), "emp_001", "auto", datetime.fromisoformat("2026-11-14T08:30:00+07:00"), "test", {}
            )
        self.assertEqual(result.exception.status, 503)
        self.assertNotIn("sensitive", result.exception.message)
        self.assertEqual(len(calls), 1)

    def test_rpc_returns_safe_domain_error_and_get_uses_projection(self):
        def handler(request):
            self.assertEqual(request.headers["apikey"], "synthetic-secret")
            if request.method == "GET":
                self.assertNotIn("face_encoding", request.url.params["select"])
                return httpx.Response(200, json=[])
            return httpx.Response(
                200, json={"error": {"code": "punch_pending", "message": "Lượt đang xử lý.", "status": 409}}
            )

        store = SupabaseStore(self.client(handler))
        self.assertEqual(store.list_attendance("2026-11-14"), [])
        with self.assertRaises(AppError) as result:
            store.complete(str(uuid4()), "test.jpg")
        self.assertEqual(result.exception.code, "punch_pending")

    def test_gallery_paginates_and_bad_remote_data_fails_closed(self):
        def handler(request):
            return httpx.Response(
                200,
                json=[{"employee_id": str(i)} for i in range(500)]
                if request.url.params["offset"] == "0"
                else [{"employee_id": "last"}],
            )

        self.assertEqual(len(SupabaseStore(self.client(handler)).list_employees()), 501)
        store = SupabaseStore(self.client(lambda _: httpx.Response(200, json={"unexpected": True})))
        with self.assertRaises(AppError):
            store.get_request(str(uuid4()))

    def test_duplicate_evidence_preserves_object_and_requires_authenticated_verification(self):
        calls = []

        def handler(request):
            calls.append(request)
            if request.method == "POST":
                self.assertEqual(request.headers["x-upsert"], "false")
                return httpx.Response(400, json={"statusCode": "409", "error": "Duplicate"})
            self.assertIn("/object/authenticated/", request.url.path)
            return httpx.Response(200, content=b"first-frame")

        photos = SupabasePhotos(self.client(handler))
        request = dict(employee_id="emp_001", attendance_date="2026-11-14", action="in", request_id=str(uuid4()))
        self.assertTrue(photos.save(request, b"second-frame").endswith(".jpg"))
        self.assertEqual(len(calls), 2)
        self.assertTrue(all("/object/public/" not in str(call.url) for call in calls))

    def test_storage_timeout_and_unverified_conflict_never_acknowledged(self):
        for status in [403, 503, 409]:
            with self.subTest(status=status):
                photos = SupabasePhotos(self.client(lambda _, status=status: httpx.Response(status, json={})))
                with self.assertRaises(AppError):
                    photos.save(
                        dict(employee_id="emp_001", attendance_date="2026-11-14", action="in", request_id=str(uuid4())),
                        b"frame",
                    )

    def test_public_bucket_refused_and_private_bucket_created(self):
        photos = SupabasePhotos(self.client(lambda _: httpx.Response(200, json={"id": BUCKET, "public": True})))
        with self.assertRaises(RuntimeError):
            photos.initialize()
        created = False

        def handler(request):
            nonlocal created
            if request.method == "POST":
                self.assertIn(b'"public":false', request.content)
                created = True
                return httpx.Response(200, json={"id": BUCKET})
            return (
                httpx.Response(200, json={"id": BUCKET, "public": False}) if created else httpx.Response(404, json={})
            )

        SupabasePhotos(self.client(handler)).initialize()
        self.assertTrue(created)

    def test_missing_bucket_wrapped_in_http_400_is_created_private(self):
        created = False

        def handler(request):
            nonlocal created
            if request.method == "POST":
                self.assertIn(b'"public":false', request.content)
                self.assertIn(b'"allowed_mime_types":["image/jpeg"]', request.content)
                created = True
                return httpx.Response(200, json={"id": BUCKET})
            if created:
                return httpx.Response(200, json={"id": BUCKET, "public": False})
            return httpx.Response(400, json={"statusCode": "404", "error": "Bucket not found", "code": "NoSuchBucket"})

        SupabasePhotos(self.client(handler)).initialize()
        self.assertTrue(created)

    def test_other_http_400_bucket_errors_do_not_create_bucket(self):
        for body in [{"code": "AccessDenied"}, {"code": "InvalidRequest"}, [], "invalid JSON"]:
            with self.subTest(body=body):
                methods = []

                def handler(request, body=body, methods=methods):
                    methods.append(request.method)
                    return httpx.Response(400, text=body) if isinstance(body, str) else httpx.Response(400, json=body)

                with self.assertRaises(AppError):
                    SupabasePhotos(self.client(handler)).initialize()
                self.assertEqual(methods, ["GET"])
