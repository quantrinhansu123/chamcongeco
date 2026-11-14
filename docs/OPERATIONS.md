# Chạy và vận hành

## Docker Compose

Cần Docker Engine/Compose. Từ thư mục gốc:

```bash
cp .env.example .env
# Điền hai khóa mạnh, khác nhau trong .env. Có thể dùng Python secrets.
docker compose build
docker compose run --rm --no-deps api python scripts/download_models.py
docker compose up -d
docker compose ps
```

PowerShell dùng `Copy-Item .env.example .env`. Model tải vào volume `model-data`; dữ liệu/ảnh vào `runtime-data`. Tải model là bước rõ ràng, không lặp trong request. Nginx chỉ bắt đầu sau khi backend health check đạt. Nếu model thiếu/sai checksum, startup dừng để sửa thay vì chấp nhận lượt chấm công không đủ kiểm tra.

Mở http://127.0.0.1:8080 tại máy chạy Docker. API không xuất port ra host, Nginx chuyển `/api` vào mạng container. Không dùng `docker compose down -v` trong vận hành vì lệnh đó xóa volume dữ liệu/model.

Để camera dùng qua LAN/Internet, đặt reverse proxy có chứng chỉ **HTTPS** phía trước port này. HTTP trên địa chỉ IP LAN thường không được trình duyệt cho truy cập camera. Giữ port Compose bind localhost khi có proxy trên cùng host; không đưa backend development không xác thực lên Internet.

Compose mặc định SQLite một máy. Nếu dùng Supabase, thêm biến môi trường vào service api theo [MIGRATION.md](MIGRATION.md) sau khi chạy schema/RPC. Model volume vẫn cần chuẩn bị. Không sao chép secret vào Docker image.

## Theo dõi và giới hạn tải

- `/healthz`: process còn phục vụ HTTP; `/readyz`: model đã nạp, gallery còn hạn và đọc được kho dữ liệu. Probe không yêu cầu API key, không trả nhân viên/vector.
- Header `Server-Timing`, log `http_completed`, `vision_completed` có thời gian theo stage. `FACE_LOG_LEVEL=INFO` mặc định; đặt `WARNING` để giảm log khi đã vận hành ổn định. Không đưa ảnh hoặc bearer key vào hệ thống log phía proxy.
- 429 là giới hạn inference có chủ đích. UI backoff, chỉ gửi ảnh mới, giữ UUID nếu chưa rõ kết quả. Nếu nhiều camera liên tục nhận 429, cần đo lại trên server thật rồi tăng tài nguyên/worker hoặc chia trạm, không giảm bảo vệ dữ liệu.
- 503: kho dữ liệu/ảnh/gallery/model chưa sẵn sàng. Pending không được coi là đã chấm công. Retry cùng UUID hoặc tra `/api/recognition-requests/{uuid}`.
- Chạy một worker trước. Nhiều worker nhân bản bộ model và gallery; Supabase SQL bảo vệ ghi qua giao dịch, SQLite chỉ phù hợp cùng host/volume local, không đặt DB WAL trên NFS/SMB.
- Kiểm tra dung lượng đĩa định kỳ. Ảnh minh chứng là phần tăng dung lượng chính; hiện chưa có tự xóa ảnh hay lịch lưu trữ. Thiết lập thời hạn lưu theo quy trình của đơn vị và sao lưu trước khi dọn.

200 hồ sơ ×5 template không phải tải lớn cho tìm kiếm RAM. Số camera và số lượt/giây mới quyết định tải. Chưa đo GPU hoặc máy chủ của đơn vị.

## Sao lưu SQLite và ảnh

Dừng API trước để ảnh và DB có cùng mốc. Giữ nguyên volume cho đến khi kiểm tra backup xong:

```bash
docker compose stop api
docker compose run --rm --no-deps --user root -v ./backups:/backup api python -c "import shutil, datetime; shutil.make_archive('/backup/attendance-' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'), 'gztar', '/data')"
docker compose start api
```

Tạo thư mục `backups` trước; bảo vệ quyền truy cập vì có dữ liệu sinh trắc học. Không commit backup. Với chạy local, dừng Uvicorn rồi sao chép toàn bộ `backend/data/runtime/`, kể cả file WAL/SHM nếu còn. Khôi phục thử ở thư mục/volume riêng trước khi thay thế dữ liệu đang dùng. Supabase cần backup DB **và** bucket, không chỉ một bên.

## Nghiệm thu tại nơi sử dụng

1. Đăng ký đủ nhiều góc cho nhóm thử, gồm kính, thay ánh sáng và chiều cao. Không dùng ảnh test public để đánh giá nhân sự.
2. Đo tỷ lệ nhận đúng lần đầu, từ chối người lạ/nhầm người, P50/P95 từ khi bấm đến khi hiện Đã lưu, ở số camera thực tế.
3. Thử ảnh in và video trên nhiều điện thoại, ánh sáng/góc khác nhau. MiniFASNet không là chứng nhận chống replay; nếu kết quả không đạt, đánh giá camera IR/depth hoặc bước xác thực bổ sung trước vận hành chính thức.
4. Ngắt mạng/kho ảnh/DB giữa lượt; xác minh retry giữ giờ gốc, không chuyển vào thành ra và không báo Đã lưu khi chưa commit.
5. Chạy đầu/cuối ca và nhiều ngày; đối chiếu timezone, trùng lượt, sao lưu và phục hồi. Chưa hỗ trợ ca qua đêm/nhiều ca.

Không hạ ngưỡng PAD/cosine chỉ để demo nhanh hơn. Thay ngưỡng cần bộ mẫu âm/dương đúng camera và ghi lại kết quả.
