# Third-party notices

Application base: [quantrinhansu123/chamcongeco](https://github.com/quantrinhansu123/chamcongeco), original authors as retained in source/project metadata. This repository contains a separately developed runtime and preserved prototype code; this notice does not replace upstream terms or grant rights over third-party assets.

## Adapted inference routines

- SCRFD output decoding/NMS and ArcFace alignment/preprocessing follow [InsightFace](https://github.com/deepinsight/insightface), Jia Guo and InsightFace contributors, MIT. Adaptations in `backend/src/backend/runtime/vision.py`: fixed pinned ONNX pack, direct sessions without SDK dependency, bounded CPU inference, NumPy similarity transform, shared detector, input/output validation. Upstream code notice: `LICENSES/InsightFace-MIT.txt`.
- MiniFASNet context cropping follows [MiniVision Silent-Face-Anti-Spoofing](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing), Apache-2.0. License: `LICENSES/Silent-Face-Apache-2.0.txt`. The application retains BGR/context crops and averages the two exported models' live-class softmax outputs, with a configurable acceptance threshold.
- ONNX tensor/softmax conventions and equivalent crop reference were checked against [DeepFace](https://github.com/serengil/deepface), Copyright (c) 2019 Sefik Ilkin Serengil, MIT. License: `LICENSES/DeepFace-MIT.txt`. DeepFace is not required or bundled by the default runtime.

Model files are not included in Git. The preparation script identifies source URLs and verifies exact SHA-256 values in `runtime/assets.py`; model weights are separate upstream artifacts.

## UI and dependencies

The optional browser enrollment guide uses Google's [MediaPipe Tasks Face Landmarker](https://github.com/google-ai-edge/mediapipe), Copyright The MediaPipe Authors, Apache-2.0. SDK 1.2.3 is pinned in the npm lockfile. Its WASM loader/binary and the official Face Landmarker task are prepared with SHA-256 verification by `frontend/scripts/prepare-vision.mjs`, hosted by the application, and not checked into Git. Application pose selection, quality checks and capture lifecycle are implemented separately; Face Landmarker does not provide identity verification or presentation-attack certification.

IBM Carbon React/styles, React, Vite, OpenCV, ONNX Runtime, FastAPI, HTTPX, NumPy, Pillow, uv, Bun and PGlite remain separate dependencies under their respective upstream terms. Lockfiles pin the tested dependency graph. Container base images are fetched at build time and should be updated with dependency/security maintenance.

The locally served Inter font includes its notice at `frontend/public/fonts/Inter-LICENSE.txt`. Original application branding/static assets are retained from the base repository where used.
