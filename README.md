# Attendly · Chấm công khuôn mặt

[![Verify](https://github.com/quantrinhansu123/chamcongeco/actions/workflows/ci.yml/badge.svg)](https://github.com/quantrinhansu123/chamcongeco/actions/workflows/ci.yml)

FastAPI + React/IBM Carbon, tối ưu cho CPU phổ thông và quy mô khoảng 200 nhân viên. Lõi mặc định: **SCRFD-500MF + MobileFaceNet (buffalo_sc) + hai MiniFASNet ONNX**. Model chạy tại máy chủ của bạn; không gọi dịch vụ AI tính tiền theo lượt nhận diện.

Đồng bộ bản phát triển [huybitvvt/chamcongeco-next](https://github.com/huybitvvt/chamcongeco-next) tại commit `8e4fe8f` về repo gốc, giữ nguyên lịch sử Git gốc. Lần đồng bộ này cập nhật mã nguồn, không chạy thay đổi database hoặc chuyển hồ sơ khuôn mặt. Xem [ghi chú bàn giao lên repo gốc](docs/UPSTREAM_SYNC.md).

## Thay đổi chính

- Giải mã ảnh/phát hiện mặt một lần; chạy hoàn toàn bằng ONNX Runtime CPU, không cần PyTorch/DeepFace ở luồng mặc định. Kiểm tra checksum và nạp model trước khi API sẵn sàng.
- Gallery bất biến trong RAM, 1–5 vector/người, có mã phiên bản model. Hồ sơ dlib cũ được giữ riêng; cần cập nhật ảnh để dùng engine mới.
- Đăng ký tự thu **5 góc qua camera** bằng MediaPipe chạy trong Web Worker: chọn khung ổn định, server kiểm tra ngay từng góc và tự thu lại ảnh chưa đạt. Browser/server dùng chung quality policy, có autofocus/exposure khi camera hỗ trợ. Xem lại trước khi lưu; có đường tải 1–5 ảnh khi camera không khả dụng.
- SQLite WAL mặc định, hoặc Supabase qua kết nối HTTP dùng lại và RPC nguyên tử. CSV cũ chỉ là nguồn nhập, không còn là kho ghi đồng thời.
- Mỗi lượt có UUID và biên nhận lưu bền vững. Retry trả lại thời gian đã lưu; bấm lặp trong 30 giây không biến giờ vào thành giờ ra. Ảnh riêng tư được lưu trước khi xác nhận công.
- Camera chỉ có một yêu cầu đang xử lý, tự điều chỉnh nhịp gửi, có timeout/backoff và khôi phục biên nhận sau mất mạng/tải lại trang. Dừng camera khi chuyển màn hình hoặc đưa tab xuống nền.
- Phân quyền quản trị/trạm, kiểm tra đồng ý phía máy chủ, giới hạn ảnh và tránh trả vector sinh trắc học ra API danh sách.

**Đây là bản đã kiểm tra phần mềm và đo cục bộ, chưa được nghiệm thu trên camera/nhân viên thật.** MiniFASNet là bộ lọc chống giả mạo thụ động, không bảo đảm chặn mọi ảnh/video. Một số ảnh chân dung công khai vẫn qua được bộ lọc. Xem [kết quả và giới hạn](docs/VERIFICATION.md), [kiến trúc](docs/ARCHITECTURE.md).

Tài liệu bàn giao: [chạy, cấu hình và nghiệm thu tại đơn vị](docs/HANDOVER.md). `face-quality-v2` đo độ nét trên crop chuẩn hóa 128×128; nếu đã tự chỉnh `FACE_MIN_SHARPNESS` ở bản cũ, cần hiệu chuẩn lại. Không dùng model phục chế/làm đẹp để tạo mẫu hoặc vượt kiểm tra người thật.

## Chạy local

Đưa bản test miễn phí lên Render + Supabase: [cấu hình và kiểm tra deploy](docs/RENDER.md), kèm [Blueprint demo tại repo phát triển](https://github.com/huybitvvt/chamcongeco-next/blob/main/render.yaml). Dịch vụ Vercel/Render Pro hiện có dùng [ghi chú đồng bộ](docs/UPSTREAM_SYNC.md).

Cần Python 3.12, [uv](https://docs.astral.sh/uv/), [Bun](https://bun.sh/) và trình duyệt có camera. Không cần GPU, CMake, dlib hay cơ sở dữ liệu bên ngoài với cấu hình mặc định.

Từ thư mục gốc:

```bash
uv sync --project backend --frozen
uv run --project backend python backend/scripts/download_models.py
```

Lệnh chuẩn bị model tải một lần từ nguồn được chỉ định và kiểm tra SHA-256. API không tải model trong lúc nhận diện. Có thể chép đủ 4 tệp đã xác minh vào `backend/models/` để chạy offline.

Mở terminal thứ nhất:

```bash
uv run --project backend uvicorn backend.main:app --host 127.0.0.1 --port 8000 --workers 1
```

Terminal thứ hai:

```bash
cd frontend
bun install --frozen-lockfile
bun run dev --host 127.0.0.1
```

Mở **http://127.0.0.1:5173**. Vite chuyển `/api` đến backend; không đặt khóa bí mật trong `VITE_*`. Giao diện cần cả frontend và backend đang chạy.

Lệnh dev/build tự chuẩn bị model hướng dẫn camera và WASM đã pin/checksum, phục vụ từ cùng địa chỉ ứng dụng. Lần đầu cần Internet để tải tài nguyên; những lần sau dùng cache trên đĩa. Chỉ nạp vào trình duyệt khi bấm bắt đầu thu, không gọi API AI bên ngoài. Để chuẩn bị trước: `cd frontend` rồi `bun run prepare:vision`. Chi tiết tại [tự thu 5 góc](docs/AUTO_ENROLLMENT.md).

Mặc định development trên localhost không yêu cầu mã truy cập. Để bật xác thực, chép `backend/.env.example` thành `backend/.env`, đặt hai mã khác nhau và đặt `APP_ENV=production`. Tệp này được backend tự đọc; biến môi trường hệ thống được ưu tiên. Sinh mã bằng:

```bash
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

Chạy hai lần để có mã quản trị và mã trạm. Nhập mã trên màn hình truy cập; mã được giữ trong `sessionStorage` của tab, không nhúng vào bản build. Chọn **Khóa phiên truy cập** sau khi quản trị. Không chia sẻ mã quản trị cho trạm chấm công.

## Sử dụng

1. Quản trị viên điền tên, xác nhận đồng ý rồi bấm **Bắt đầu thu 5 góc**. Nhân viên nhìn thẳng, quay trái/phải, ngẩng/cúi nhẹ theo chỉ dẫn; hệ thống tự chọn ảnh, kiểm tra ngay trên server rồi mới đánh dấu từng góc. Đủ **Đã kiểm tra 5/5 góc** thì camera tự dừng. Xem lại rồi bấm **Lưu nhân viên**. Có thể chụp lại riêng góc lỗi hoặc chọn **Tải ảnh lên** để dùng 1–5 ảnh có sẵn.
2. Nhân viên bấm **Chấm công**, nhìn thẳng camera. Chỉ một người trong khung hình. Lượt đầu ngày ghi giờ vào; lượt tiếp theo sau khoảng chống bấm lặp ghi giờ ra.
3. Chỉ biên nhận `confirmed` mới hiển thị **Đã lưu**. Khi mất mạng, bấm lại sẽ kiểm tra lượt đang chờ trước khi tạo lượt mới.
4. Hồ sơ cũ có nhãn **Cần cập nhật khuôn mặt**: quản trị viên chọn **Cập nhật ảnh** trên đúng nhân viên. Mã nhân viên và lịch sử công được giữ nguyên.

Máy chủ ghi giờ theo `Asia/Ho_Chi_Minh`; đồng bộ đồng hồ/NTP khi triển khai. Bản này hỗ trợ **một lần vào và một lần ra/người/ngày**, chưa có ca qua đêm, nhiều ca hoặc chỉnh công thủ công.

## Dữ liệu, chuyển đổi và triển khai

- SQLite + ảnh: `backend/data/runtime/`. Model: `backend/models/`. Các thư mục này không đưa lên Git.
- Không tự chuyển 128 chiều sang 512 chiều. [Hướng dẫn nhập CSV, Supabase và quay lại dlib](docs/MIGRATION.md).
- [Docker Compose, HTTPS, sao lưu và vận hành](docs/OPERATIONS.md). Để dùng camera từ máy khác/điện thoại, cần HTTPS.
- `/healthz`: tiến trình; `/readyz`: model, gallery và kết nối kho dữ liệu; `/docs`: hợp đồng API. API nghiệp vụ yêu cầu Bearer key khi bật xác thực.
- Đầu vào ảnh JPEG/PNG, tối đa 5 MB/ảnh, 12 triệu pixel. Gallery quá hạn đồng bộ thì từ chối chấm công thay vì dùng dữ liệu cũ vô thời hạn.

## Kiểm tra

```bash
uv run --project backend pytest backend/tests -q
uv run --project backend ruff check backend/src/backend/runtime backend/scripts/download_models.py backend/scripts/import_csv.py backend/scripts/benchmark_runtime.py
cd frontend
bun run lint
bun run test:unit
bun run build
bunx playwright install chromium
# Mở bun run dev ở terminal khác trước khi chạy:
node --test --test-concurrency=1 tests/*.mjs
node scripts/smoke-enrollment-worker.mjs
cd ../tools
bun install --frozen-lockfile
bun run test:sql
```

Trên Windows có Edge, đặt `$env:PLAYWRIGHT_CHANNEL='msedge'` trước lệnh test trình duyệt. CI tự dựng Vite và chạy các kiểm tra, thêm build hai container.

Test mặc định dùng dữ liệu tổng hợp và model giả ở ranh giới inference, không tải trọng số. Test SQL dùng PostgreSQL nhúng PGlite; không thay thế nghiệm thu Supabase thật. Đo API với model thật bằng script [benchmark_runtime.py](backend/scripts/benchmark_runtime.py), luôn dùng cơ sở dữ liệu tạm riêng.

`uv sync --project backend --extra legacy` cài thêm dlib để chạy bộ regression cũ hoặc adapter `FACE_ENGINE=dlib`. Code prototype được giữ để đối chiếu; entrypoint sử dụng là **`backend.main:app`**.

## Cấu trúc

```text
backend/src/backend/runtime/  API, ONNX, gallery, service, SQLite/Supabase, ảnh riêng
backend/scripts/              chuẩn bị model, nhập CSV, benchmark độc lập
backend/supabase/             schema và migration RPC
backend/tests/                kiểm tra luồng, lỗi, đồng thời và tương thích cũ
frontend/src/                 giao diện Carbon, camera, phân quyền và biên nhận
frontend/tests/               kiểm tra trình duyệt desktop/mobile với fake camera
tools/                        kiểm tra hợp đồng PostgreSQL
docs/                         kiến trúc, vận hành, chuyển đổi, bằng chứng kiểm tra
```

Ghi nhận mã nguồn và nguồn model tại [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
