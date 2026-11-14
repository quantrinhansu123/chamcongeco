# Kết quả kiểm chứng

Ngày 14/11/2026. Máy phát triển Windows, Intel Core i3-1215U, RAM 8 GB, ONNX CPU 1 luồng, OpenCL tắt. Đây không phải cấu hình server của đơn vị; chưa có thông tin server và số camera đồng thời. Không có số đo GPU.

## Phần mềm

- **83 test Python đạt**, gồm bộ regression cũ và runtime mới: vào/ra, giữ giờ đầu, retry sau restart, concurrent intents, lỗi ảnh/DB, pending hết hạn, timezone, consent, quyền kiosk/admin, profile model, CSV import, bộ 5 góc/lỗi theo ảnh, quality chuẩn hóa và preflight không ghi dữ liệu/khác người/khóa bận/kiểm tra lại lúc lưu. 2 cảnh báo thư viện: legacy `pkg_resources` và Starlette TestClient/httpx.
- **27 kiểm tra PostgreSQL đạt** qua PGlite: migration chạy lại được, reserve/complete, object ảnh bắt buộc, idempotency, cooldown, giữ model cũ và quyền anon. PGlite dùng một kết nối; không chứng minh khóa đồng thời giữa nhiều session Supabase thật.
- **12 test trình duyệt đạt** trên Edge với fake camera/API/pose tracker: UI desktop/mobile 1440–320 px, bàn phím, consent, tự thu 5 góc, chụp lại ảnh lỗi, dừng camera/worker, hủy khi đang tải/đang kiểm tra, từ chối quyền camera, vào/ra, phân quyền, cập nhật mặt cũ và khôi phục sau mất phản hồi. Preflight kiểm tra đủ 5 góc, tự thay ảnh mờ/khác người, retry 429, dừng sau 3 lỗi dịch vụ hoặc 8 ảnh chưa đạt; không tính ảnh chưa được xác nhận và không tự lưu hồ sơ.
- **14 unit test frontend đạt**, 192 assertions: pose, thời gian giữ ổn định, bỏ frame đầu khi camera đang ổn định, xếp hạng ảnh, reset khi rung/mất mặt/nhiều mặt; golden pixels dùng chung Python/TypeScript; policy server và autofocus/exposure, driver không hỗ trợ/treo/hủy. Không dùng timer để thu đủ góc từ các frame chính diện giống nhau.
- Worker **MediaPipe/SDK/WASM thật** chạy qua UI trên Edge: nạp tài nguyên cùng origin khi bấm bắt đầu, từ chối fake camera không có mặt, dừng và giải phóng camera. Thử thêm video giả từ ảnh public trả 1 mặt, góc hữu hạn và chất lượng hợp lệ. Không phải thử đủ 5 góc bằng webcam vật lý. Script: `frontend/scripts/smoke-enrollment-worker.mjs`.
- Một lượt nối **UI thật → API thật → ONNX/PAD thật → SQLite/ảnh thật → biên nhận** cũng đạt, dùng danh tính tổng hợp và video camera giả từ ảnh developer public trong DB riêng. Không mock API/model, không đụng dữ liệu nhân viên; vẫn không là kiểm chứng camera vật lý hoặc liveness ngoài thực tế. Script tùy chọn: `frontend/scripts/smoke-real.mjs`.
- Bộ mặc định không cần dlib/Torch/DeepFace gồm **47 test**; 36 test prototype bổ sung chỉ chạy khi cài extra `legacy`. CI kiểm tra cài mới và chạy bộ mặc định.
- Frontend TypeScript/build và lint đạt; Carbon hiện phát cảnh báo deprecation Sass khi build. Không có lỗi build từ các cảnh báo đó.
- Native SCRFD decode/landmark và embedding đối chiếu InsightFace SDK 2.1 trên 3 ảnh public: bbox/landmark lệch <0.001 px, cosine embedding >0.999999, crop căn chỉnh lệch pixel tối đa 1. Hai context crop PAD đối chiếu nguồn MiniVision/DeepFace trùng pixel trên 6 ảnh.

Chi tiết chạy mới nhất còn được ghi trong GitHub Actions của repository. CI Linux kiểm tra cài môi trường mặc định, SQL, UI, ONNX HTTP smoke và build container; chỉ coi là đạt khi workflow thực sự xanh.

## Quality v2 và kiểm tra từng góc

Đã chạy lại 18 khung hình công khai/suy giảm tổng hợp bằng **worker MediaPipe thật của app**, so với `Vision.analyze` và endpoint preflight thật trong DB tạm. Ở bản cũ có 6 trường hợp browser cho qua nhưng server báo mờ; bản mới còn **0/18 trường hợp theo hướng lỗi này**. Các trường hợp blur nặng vẫn bị chặn. Còn một trường hợp sát ngưỡng browser chặt hơn server do khác bbox/JPEG; không hứa điểm số giữa hai detector trùng tuyệt đối. Đây là phép tái hiện lỗi, không phải thống kê độ chính xác trên nhân viên/camera thật. Số liệu tại [quality-scale-regression.json](benchmarks/quality-scale-regression.json).

`verify_enrollment.py` đã chạy ONNX CPU thật với 2 ảnh công khai khác người: ảnh gốc/phóng lớn đều đạt; ảnh mờ nặng và khác người bị từ chối; preflight không tạo hồ sơ/ảnh/công; batch cuối tạo một hồ sơ tổng hợp trong SQLite tạm. Các trường pose dùng cùng ảnh tĩnh chỉ kiểm tra hợp đồng API, không chứng minh đủ 5 tư thế thật. 7 preflight ASGI TestClient có p50 72.64 ms, max 302.34 ms trong lần đo sơ bộ trên máy dev, chưa gồm WAN; không phải SLA. Xem [enrollment-preflight-cpu.json](benchmarks/enrollment-preflight-cpu.json).

**Bản nền đã đạt CI Linux** tại [run 43599739494](https://github.com/huybitvvt/chamcongeco-next/actions/runs/43599739494): cả 3 job backend, frontend/SQL và containers. Ngoài build, Compose thực sự khởi động với model volume mới và API production: Nginx phục vụ UI, từ chối thiếu key, nhận key trạm, quản trị đăng ký ảnh developer, ONNX/PAD ghi một lượt công và một ảnh private; retry cùng UUID giữ nguyên giờ/biên nhận và không tạo ảnh thứ hai. Workflow quality v2 bổ sung policy/preflight qua Nginx, từ chối kiosk và kiểm tra không ghi hồ sơ/ảnh; đối chiếu [run của đúng commit cần bàn giao](https://github.com/huybitvvt/chamcongeco-next/actions/workflows/ci.yml). Dữ liệu kiểm tra tổng hợp và volume tạm được dọn trên runner; không có kết nối Supabase thật.

## API thật, không thay model hoặc kho ảnh/DB bằng mock

Script `backend/scripts/benchmark_runtime.py` khởi động Uvicorn trên localhost, dùng ONNX thật, SQLite WAL, JPEG minh chứng được fsync và lưu riêng. Gallery **200 người ×5 template**: một hồ sơ từ ảnh developer public, các hồ sơ còn lại tổng hợp. Đồng hồ test tăng ngày để mỗi lượt tạo record/ảnh mới, không vô tình đo toàn bộ ở nhánh trả biên nhận trùng. Dữ liệu tạm bị dọn sau benchmark, không đụng DB đang sử dụng.

| Đường xử lý | Mẫu | P50 | P95 | Lớn nhất |
|---|---:|---:|---:|---:|
| Nhận diện + PAD + match + HTTP localhost + ảnh + SQLite + phản hồi | 600 | 64.16 ms | 103.00 ms | 304.86 ms |
| Gửi lại UUID đã xác nhận, trả nguyên biên nhận | 600 | 5.49 ms | 7.84 ms | 9.74 ms |

Bảng 600 mẫu là baseline trước quality v2, được giữ để đối chiếu. Với quality v2, lượt đo lại **60 lượt công** cùng cấu hình gallery đạt p50 **72.03 ms**, p95 **128.33 ms**, max **587.46 ms**; retry p50 8.38 ms/p95 10.37 ms. Có đúng 61 ảnh, mẫu spoof F1 bị chặn 403; burst 4 client có 20×200 và 20×429. Báo cáo: [full-runtime-quality-v2.json](benchmarks/full-runtime-quality-v2.json). Lần đo 60 mẫu trước đó p50 110.84 ms/p95 134.49 ms/max 328.79 ms cũng được giữ ở [full-runtime-quality-v2-prior.json](benchmarks/full-runtime-quality-v2-prior.json). Máy dev có biến thiên giữa các lượt; không suy ra SLA hay tốc độ tăng/giảm của riêng thuật toán từ hai đợt đo khác thời điểm.

Đây là lượt đo lại sau khi hoàn tất hợp đồng response API. Lượt 600 mẫu trước đó có P50 66.26 ms, P95 104.92 ms và một lượt chậm **1.48 giây**; giữ cả báo cáo trước tại `benchmarks/runtime-cpu-600-prior.json`, không loại ngoại lệ để tuyên bố SLA. Model warm-up khoảng 433 ms trong lượt mới (không gồm tải model, cài package hoặc cold boot toàn tiến trình). Mỗi lượt đo tạo đúng **601 ảnh** cho 600 lượt riêng và một lượt trong đợt burst; retry không tạo ảnh trùng.

Burst 4 client/40 yêu cầu: **24 HTTP 200, 16 HTTP 429**, không có 5xx, P95 toàn bộ yêu cầu khoảng 144 ms. 429 là backpressure, **không phải 40 lượt chấm công thành công**. Chưa thể suy ra đủ phục vụ bao nhiêu camera liên tục trên server thật. Mẫu khoảng một phút cũng không thay thế chạy bền nhiều giờ/ngày.

Mạng WAN, camera/browser capture, HTTPS, Supabase DB/Storage thật không nằm trong số đo 64/103 ms trên. Phản hồi tại người dùng còn cộng các phần này. Không so trực tiếp số đó với thời gian AI đơn thuần của bản cũ.

## Nghiên cứu trước triển khai

Trên cùng máy, microbenchmark 60 ảnh lặp từ 3 ảnh mẫu, gallery 200 vector tổng hợp:

| Pipeline AI | P50 | Ghi chú |
|---|---:|---|
| dlib + DeepFace/PyTorch cũ | 517.9 ms | Có phát hiện/tiền xử lý lặp |
| YuNet + SFace + MiniFASNet ONNX | 43.7 ms | Ứng viên đã đo |
| buffalo_sc + MiniFASNet ONNX | khoảng 30 ms | Chọn cho CPU trong bản này |
| buffalo_l @320 / @640 | khoảng 563 / 766 ms | Không chọn mặc định CPU máy thử |

Đây là thời gian tính toán AI, không phải tiền API; không gồm mạng/DB/ảnh. Lựa chọn buffalo_sc dựa trên tốc độ/cách tích hợp ở máy thử, **không khẳng định độ chính xác sinh trắc học cao nhất**.

## Chống giả mạo và độ chính xác: giới hạn thực tế

Hai mẫu `image_F1.jpg`, `image_F2.jpg` của [Silent-Face-Anti-Spoofing](https://github.com/minivision-ai/Silent-Face-Anti-Spoofing/tree/master/images/sample) bị từ chối 403; mẫu `image_T1.jpg` được chấp nhận. Chỉ là smoke test đúng đường model.

Ba ảnh chân dung developer public thông thường cũng có điểm live cao và được chấp nhận. Điều này cho thấy **không thể coi PAD RGB này là bảo đảm chặn mọi ảnh/video**. Không suy diễn smoke test thành tỷ lệ chống replay, FAR/FRR hay nhận đúng nhân viên. Chưa có mẫu thật của 200 người và chưa đo ở camera triển khai.

Để nghiệm thu, cần test nhận đúng/nhầm/người lạ, nhiều điều kiện và ảnh in/video trên thiết bị thật theo [OPERATIONS.md](OPERATIONS.md). Nếu yêu cầu chống gian lận cao mà RGB PAD không đạt, phải đánh giá phần cứng IR/depth hoặc xác thực bổ sung. Chưa có cam kết tuyệt đối hoặc chứng nhận sinh trắc học.

## Chưa được xác minh trong môi trường triển khai

- Supabase/Storage thật, timeout WAN và triển khai hosting của đơn vị.
- GPU, nhiều camera chạy liên tục, khả năng chịu tải server thật.
- Độ chính xác trên nhân viên và hiệu quả chống ảnh/video ngoài bộ mẫu nhỏ.
- Chạy bền nhiều giờ/ngày, backup/restore trên dữ liệu vận hành thực tế.

Các số đo ngày 14/11 được thực hiện trước khi đồng bộ về repository gốc. Từ ngày 15/11, mã nguồn bản phát triển tại commit `8e4fe8f` được đưa về repo gốc, giữ lịch sử gốc; xem [ghi chú đồng bộ](UPSTREAM_SYNC.md). Lần đồng bộ mã không xác nhận cấu hình hoặc database của dịch vụ Pro đã được cập nhật.
