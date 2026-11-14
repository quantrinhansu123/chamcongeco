# Bàn giao vận hành

Mã nguồn bàn giao: https://github.com/quantrinhansu123/chamcongeco. Runtime được phát triển tại https://github.com/huybitvvt/chamcongeco-next và đồng bộ về repo gốc từ commit `8e4fe8f`. Xem [phạm vi đồng bộ và cấu hình dịch vụ Pro](UPSTREAM_SYNC.md). Database và hồ sơ mặt không được chuyển đổi trong lần đồng bộ này.

## Chuẩn bị và chạy

1. Dùng README để cài môi trường hoặc Docker Compose. Copy `.env.example` thành `.env` (PowerShell: `Copy-Item .env.example .env`), điền hai khóa admin/kiosk khác nhau, dài ít nhất 32 ký tự. Không đặt khóa vào biến `VITE_*` hay commit Git.
2. `docker compose build`, `docker compose run --rm --no-deps api python scripts/download_models.py`, rồi `docker compose up -d --wait`. Mở `http://127.0.0.1:8080` tại máy chạy, hoặc cấu hình HTTPS khi truy cập từ máy khác. Không đổi địa chỉ bind public khi chưa cấu hình reverse proxy/TLS.
3. Admin đăng ký nhân viên; kiosk chỉ chấm công. Hồ sơ dlib cũ cần đăng ký lại trước khi dùng InsightFace; mã nhân viên và lịch sử công được giữ khi dùng chức năng cập nhật mặt. Fresh clone không có dữ liệu nhân viên sẵn.
4. Hướng dẫn sử dụng camera: nhập họ tên + xác nhận đồng ý, bắt đầu thu, giữ từng góc theo hướng dẫn, đợi **Đã kiểm tra 5/5 góc**, xem lại rồi lưu. Ảnh lỗi tự được chọn lại; nếu vượt số lần thử, chỉnh ánh sáng/khoảng cách và tiếp tục. Camera mờ nặng hoặc bị che phải xử lý tại thiết bị; không có chế độ AI tạo thêm chi tiết mặt để vượt kiểm tra.

## Thay đổi kiểm tra chất lượng cần biết

Policy `face-quality-v2` dùng ROI 128×128 ở cả browser và server, thay cho Laplacian ở độ phân giải gốc của server trước đây. Mặc định `FACE_MIN_SHARPNESS=40`, độ sáng 45–220, mặt tối thiểu 80 px. Giá trị nét từng được chỉnh trên bản cũ phải hiệu chuẩn lại. Browser lấy cấu hình trực tiếp từ API; server vẫn kiểm tra riêng từng ảnh và cả bộ trước khi lưu. Không đổi ngưỡng nhận dạng, margin hoặc PAD chỉ để ảnh mờ qua được.

Preflight không ghi hồ sơ, ảnh hay lượt công. Ảnh đã chọn và ảnh thẳng tham chiếu được gửi đến API hệ thống bằng quyền admin sau đồng ý; không gửi live video đến nhà cung cấp AI. Worker/model phục vụ cùng origin. Server không giữ ảnh preflight giữa các request và không trả vector về browser. Chi tiết trong [AUTO_ENROLLMENT.md](AUTO_ENROLLMENT.md).

## Kiểm tra tại nơi triển khai

Các kiểm thử tự động và số đo ở [VERIFICATION.md](VERIFICATION.md) không chứng minh tỷ lệ nhận dạng trên 200 nhân viên. Khi bàn giao cần ghi lại máy/server/camera, môi trường sáng, phiên bản triển khai và kết quả thử người thật:

- Đăng ký/nhận đúng cùng người ở nhiều buổi, kính/không kính, mờ nhẹ/thiếu sáng; người lạ không được ghi công.
- Mỗi người chỉ ghi một lượt; retry/mất mạng giữ giờ và biên nhận; nút dừng/đổi tab tắt camera. Thử ít nhất các camera/trình duyệt thực tế sẽ dùng.
- Thử ảnh in và video trên màn hình. MiniFASNet RGB có giới hạn; thu đủ 5 góc không phải chứng nhận liveness. Không ghi nhận đạt chống replay nếu chưa thử tại thiết bị.
- Thử tải đúng số camera đồng thời, thời gian phản hồi p95, backup/restore và chạy liên tục trên hạ tầng đích. Supabase thật/GPU chỉ được ghi đạt sau khi đo thực tế.

Lưu dữ liệu nghiệm thu ở nơi riêng, không đưa ảnh/vector/tên nhân viên vào repo public. Sao lưu volume theo [OPERATIONS.md](OPERATIONS.md); xác minh restore trước khi xóa backup cũ. Không thay model embedding và trộn vector khác model.

## Lệnh kiểm tra phần mềm

Tại root: `uv run --project backend pytest backend/tests -q`. Tại `frontend`: `bun run lint`, `bun run test:unit`, `bun run build`; bật Vite trước khi chạy `node --test --test-concurrency=1 tests/*.mjs` (Windows đặt `PLAYWRIGHT_CHANNEL=msedge`). Tests browser dùng camera/API giả để kiểm tra tương tác; smoke worker riêng dùng SDK thật.

Sau khi tải ONNX, chạy `uv run --project backend python backend/scripts/verify_enrollment.py --image <anh-mau-cong-khai.jpg>`. Script tạo DB tạm rồi xóa, không dùng dữ liệu nhân viên. Chạy `benchmark_runtime.py` theo README để đo thêm localhost HTTP/PAD/SQLite/ảnh bằng dữ liệu tổng hợp. Để thử UI với API thật dùng `frontend/scripts/smoke-real.mjs`, chỉ trỏ vào backend SQLite tạm như điều kiện bảo vệ của script.
