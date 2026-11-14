"""Pooled server-only REST transport. Writes are never automatically retried."""

from datetime import datetime

import httpx

from .errors import AppError, unavailable


def create_client(url: str, secret: str) -> httpx.Client:
    return httpx.Client(
        base_url=url.rstrip("/"),
        headers={"apikey": secret, "Authorization": f"Bearer {secret}"},
        timeout=httpx.Timeout(10, connect=3, pool=2),
        limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
        follow_redirects=False,
    )


class SupabaseStore:
    def __init__(self, client: httpx.Client, *, cooldown=30, pending_timeout=120):
        self.client, self.cooldown, self.pending_timeout = client, cooldown, pending_timeout

    def _call(self, method: str, path: str, *, params=None, payload=None):
        try:
            response = self.client.request(
                method, "/rest/v1/" + path, params=params, json=payload, headers={"Prefer": "return=representation"}
            )
            if response.status_code == 409 and path == "employees":
                raise AppError("duplicate_employee", "Tên hoặc mã nhân viên đã tồn tại.", 409)
            response.raise_for_status()
            body = response.json()
            if isinstance(body, dict) and "error" in body:
                error = body["error"]
                raise AppError(error["code"], error["message"], int(error.get("status", 409)))
            return body
        except (httpx.HTTPError, ValueError) as error:
            raise unavailable() from error

    def close(self):
        self.client.close()

    def check_health(self):
        self._call("GET", "employees", params={"select": "employee_id", "limit": "1"})

    def list_employees(self):
        result, offset = [], 0
        while True:
            rows = self._call(
                "GET",
                "employees",
                params={
                    "select": "employee_id,name,image_filename,created_at,face_encoding,face_templates,face_profiles,face_model,face_updated_at,consented_at",
                    "order": "created_at.asc,employee_id.asc",
                    "limit": "500",
                    "offset": str(offset),
                },
            )
            if not isinstance(rows, list):
                raise unavailable()
            result.extend(rows)
            if len(rows) < 500:
                return result
            offset += 500

    def create_employee(self, employee):
        rows = self._call("POST", "employees", payload=employee)
        if not isinstance(rows, list) or len(rows) != 1:
            raise unavailable()
        return rows[0]

    def update_face(self, employee_id, changes):
        return self._call(
            "POST", "rpc/update_employee_face", payload={"p_employee_id": employee_id, "p_changes": changes}
        )

    def list_attendance(self, day):
        rows = self._call(
            "GET",
            "attendance",
            params={
                "select": "attendance_date,employee_id,arrived_at,departed_at",
                "attendance_date": f"eq.{day}",
                "order": "arrived_at.asc",
                "limit": "1000",
            },
        )
        if not isinstance(rows, list):
            raise unavailable()
        return rows

    def get_request(self, request_id):
        rows = self._call(
            "GET", "punch_requests", params={"select": "*", "request_id": f"eq.{request_id}", "limit": "1"}
        )
        if not isinstance(rows, list):
            raise unavailable()
        return rows[0] if rows else None

    def reserve(self, request_id: str, employee_id: str, action: str, now: datetime, model_id: str, context: dict):
        return self._call(
            "POST",
            "rpc/reserve_attendance_request",
            payload=dict(
                p_request_id=request_id,
                p_employee_id=employee_id,
                p_action=action,
                p_now=now.isoformat(),
                p_day=now.date().isoformat(),
                p_model_id=model_id,
                p_context=context,
                p_cooldown=self.cooldown,
                p_pending_timeout=self.pending_timeout,
            ),
        )

    def expire_request(self, request_id, now):
        return self._call(
            "POST",
            "rpc/expire_attendance_request",
            payload={"p_request_id": request_id, "p_now": now.isoformat(), "p_timeout": self.pending_timeout},
        )

    def complete(self, request_id, photo_path):
        return self._call(
            "POST", "rpc/complete_attendance_request", payload={"p_request_id": request_id, "p_photo_path": photo_path}
        )
