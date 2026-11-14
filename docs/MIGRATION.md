# Chuyển dữ liệu và thay engine

Không có phép chuyển đúng từ vector dlib 128 chiều sang vector MobileFaceNet 512 chiều. Nhập hồ sơ giữ mã/tên/lịch sử, sau đó cập nhật 1–5 ảnh trên **đúng nhân viên**. Không đăng ký nhân viên mới chỉ để thay model.

## CSV → SQLite

Dừng hệ thống ghi cũ, sao lưu CSV gốc và ảnh nếu có. Script đọc UTF-8/UTF-8 BOM, kiểm tra toàn bộ đầu vào trước ghi. Mặc định chỉ dry-run và không tạo DB:

```bash
uv run --project backend python backend/scripts/import_csv.py --employees backend/data/employees.csv --attendance backend/data/attendance.csv
```

Khi dữ liệu hợp lệ:

```bash
uv run --project backend python backend/scripts/import_csv.py --employees backend/data/employees.csv --attendance backend/data/attendance.csv --apply
```

Thêm `--database /duong-dan/attendance.sqlite3` nếu dùng thư mục khác. Nguồn CSV không thay đổi. Import trong một giao dịch; gặp hồ sơ/giờ công xung đột thì rollback, không ghi đè. Chạy lại dữ liệu y hệt không tạo trùng. Có hỗ trợ `departed_at` nếu CSV có cột này; CSV cũ thiếu cột thì giữ trống, không suy diễn giờ ra. Dòng `is_arrive=false` được bỏ qua và đếm trong báo cáo. Timestamp không có timezone được hiểu theo giờ Việt Nam và được đếm để người vận hành kiểm tra.

CSV không có ảnh minh chứng thì import không tạo ảnh giả. Những bản ghi lịch sử đó có photo path trống. Import xong khởi động backend với `STORAGE_BACKEND=sqlite`; các hồ sơ dlib được đánh dấu cần cập nhật khuôn mặt.

## Supabase hiện có hoặc mới

Không chạy reset/drop bảng. Dừng API cũ khi chuyển để không có hai ứng dụng cùng chọn giờ vào/ra.

1. Sao lưu database và bucket qua công cụ của Supabase. Ghi lại số hồ sơ/bản công để đối chiếu.
2. Với dự án mới, chạy `backend/supabase/schema.sql`, rồi `backend/supabase/003_runtime.sql` trong SQL Editor. Với dự án đang dùng schema tương ứng của repo, chạy `003_runtime.sql`. Migration thêm cột/bảng/RPC, giữ dữ liệu cũ. Kiểm tra schema thực tế trước nếu đã có tùy biến.
3. Nếu đã nhập mã `emp_N` thủ công, chạy `backend/supabase/sequence_sync.sql` để mã tiếp theo không trùng.
4. Đặt `STORAGE_BACKEND=supabase`, `SUPABASE_URL=https://YOUR_PROJECT.supabase.co`, `SUPABASE_SECRET_KEY` trong môi trường **backend**. Bật production/admin/kiosk keys. Không đặt những giá trị bí mật này trong frontend/Git.
5. Backend kiểm tra/tạo bucket `attendance-photos` riêng tư. Nếu bucket đang public, startup bị từ chối; sửa quyền bucket trước.
6. Kiểm tra `/readyz`, danh sách, cập nhật mặt trên một hồ sơ thử và chấm vào/ra; đối chiếu record, UUID receipt và object ảnh.

Migration được kiểm tra bằng PostgreSQL/PGlite và HTTPX transport giả. Chưa có xác nhận kết nối Supabase thật trong phiên phát triển; cần chạy bước 6 với dự án triển khai.

## Quay lại engine dlib trong runtime mới

```bash
uv sync --project backend --frozen --extra legacy
```

Đặt `FACE_ENGINE=dlib` và restart. Bộ PAD vẫn là MiniFASNet ONNX, luồng DB/biên nhận vẫn mới. Hồ sơ dlib gốc được giữ trong `face_profiles` khi cập nhật MobileFaceNet; người chỉ đăng ký bằng engine mới sẽ cần enrollment dlib nếu quay lại. Không trộn hai loại vector.

Chuyển adapter không tự phục hồi một DB đã bị sửa ngoài hệ thống. Để rollback cả ứng dụng, dùng bản sao lưu nhất quán và dừng writer trước; CSV gốc vẫn có thể dùng cho prototype ban đầu nhưng không chứa công phát sinh mới trong SQLite/Supabase.
