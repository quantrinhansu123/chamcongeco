"""Real ONNX + localhost HTTP + SQLite/private JPEG benchmark, synthetic records.

Never uses the configured production database. No biometrics/photos are exported.
Use a developer sample image, not employee data. No accuracy/PAD certification.
"""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
import json
from pathlib import Path
import socket
import tempfile
from threading import Thread
from time import perf_counter, sleep
from uuid import uuid4
from zoneinfo import ZoneInfo

import httpx
import numpy as np
import uvicorn

from backend.runtime.app import create_app
from backend.runtime.settings import Settings
from backend.runtime.store import SqliteStore, replace_profile
from backend.runtime.vision import Vision


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, type=Path)
    parser.add_argument("--spoof", type=Path, action="append", default=[])
    parser.add_argument("--runs", type=int, default=60)
    parser.add_argument("--employees", type=int, default=200)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if args.runs < 1 or args.employees < 1:
        parser.error("runs/employees must be positive")
    raw = args.image.read_bytes()
    with tempfile.TemporaryDirectory(prefix="attendly-benchmark-") as temp:
        settings = Settings(data_dir=Path(temp))
        vision = Vision(settings)
        warm = perf_counter()
        vision.warm_up()
        warm_ms = (perf_counter() - warm) * 1000
        analysis = vision.analyze(raw)
        if len(analysis.faces) != 1:
            raise ValueError("Benchmark needs one detected face")
        vector = analysis.faces[0].embedding
        store = SqliteStore(Path(temp) / "benchmark.sqlite3")
        rng = np.random.default_rng(20261114)
        for index in range(args.employees):
            vectors = np.tile(vector, (5, 1)) if index == 0 else rng.normal(size=(5, 512)).astype(np.float32)
            vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
            store.create_employee(
                replace_profile(
                    dict(name=f"Synthetic {index:03d}", created_at="2026-01-01T00:00:00+07:00"),
                    dict(
                        image_filename="synthetic.jpg",
                        face_model=vision.model_id,
                        face_encoding=vectors[0].tolist(),
                        face_templates=vectors.tolist(),
                    ),
                )
            )
        clock = [datetime(2026, 1, 1, 8, 30, tzinfo=ZoneInfo(settings.timezone))]
        app = create_app(settings, vision=vision, store=store, clock=lambda: clock[0])
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error", access_log=False))
        thread = Thread(target=server.run, daemon=True)
        thread.start()
        deadline = perf_counter() + 30
        while not server.started:
            if not thread.is_alive() or perf_counter() > deadline:
                raise RuntimeError("Benchmark server failed to start")
            sleep(0.05)
        try:
            with httpx.Client(base_url=f"http://127.0.0.1:{port}", timeout=20) as client:
                assert client.get("/readyz").status_code == 200

                def punch(key=None, image=raw):
                    start = perf_counter()
                    response = client.post(
                        "/api/recognize",
                        data={"request_id": key or str(uuid4()), "action": "auto"},
                        files={"image": ("sample.jpg", image, "image/jpeg")},
                    )
                    return response, (perf_counter() - start) * 1000

                full = []
                for _ in range(args.runs):
                    # Advance the injected TEST clock so every request creates a new
                    # attendance row/photo, rather than measuring only duplicate reads.
                    clock[0] += timedelta(days=1)
                    response, duration = punch()
                    assert response.status_code == 200, response.text
                    body = response.json()
                    assert body["status"] == "confirmed" and body["attendance_updated"] == ["emp_001"]
                    full.append(duration)
                key = body["request_id"]
                replay = []
                for _ in range(args.runs):
                    response, duration = punch(key)
                    assert response.json()["attendance"] == body["attendance"]
                    replay.append(duration)
                spoof = []
                for path in args.spoof:
                    response, duration = punch(image=path.read_bytes())
                    assert response.status_code == 403 and response.json()["code"] == "spoof_detected", response.text
                    spoof.append({"fixture": path.name, "status": response.status_code, "ms": round(duration, 2)})
                clock[0] += timedelta(days=1)

                def concurrent(_):
                    response, duration = punch()
                    assert response.status_code in (200, 409, 429), response.text
                    return response.status_code, duration

                with ThreadPoolExecutor(max_workers=4) as pool:
                    burst = list(pool.map(concurrent, range(40)))

                def stats(values):
                    return dict(
                        samples=len(values),
                        p50_ms=round(float(np.percentile(values, 50)), 2),
                        p95_ms=round(float(np.percentile(values, 95)), 2),
                        max_ms=round(max(values), 2),
                    )

                paths = list((Path(temp) / "photos").rglob("*.jpg"))
                result = dict(
                    scope="localhost HTTP, real CPU ONNX/PAD, SQLite WAL + fsynced private JPEG; synthetic gallery/test clock",
                    employees=args.employees,
                    templates_per_employee=5,
                    model=vision.model_id,
                    cpu_threads=1,
                    warm_up_ms=round(warm_ms, 1),
                    full_punch=stats(full),
                    receipt_retry=stats(replay),
                    upstream_spoof_smoke=spoof,
                    four_client_burst={
                        str(code): sum(item[0] == code for item in burst)
                        for code in sorted(set(row[0] for row in burst))
                    },
                    burst_latency=stats([item[1] for item in burst]),
                    evidence_files=len(paths),
                    expected_evidence_files=args.runs + 1,
                )
                assert len(paths) == args.runs + 1
                print(json.dumps(result, indent=2))
                if args.output:
                    args.output.parent.mkdir(parents=True, exist_ok=True)
                    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        finally:
            server.should_exit = True
            thread.join(20)
            if thread.is_alive():
                raise RuntimeError("Benchmark server did not stop")


if __name__ == "__main__":
    main()
