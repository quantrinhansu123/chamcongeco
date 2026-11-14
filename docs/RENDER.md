# Bản test Render Free + Supabase

Tài liệu này dành cho demo Free riêng tại `huybitvvt/chamcongeco-next`, nhánh `main`. [Blueprint `render.yaml`](https://github.com/huybitvvt/chamcongeco-next/blob/main/render.yaml) khai báo một Docker Web Service gói **Free** ở Singapore và một Static Site. Không tạo Render PostgreSQL hoặc ổ đĩa trả phí.

Dịch vụ Vercel/Render Pro gốc giữ cấu hình trong dashboard; xem [ghi chú đồng bộ](UPSTREAM_SYNC.md). Repo gốc không đặt Blueprint Free tại root để tránh nhầm với các dịch vụ Pro hiện có.

## Supabase

Tạo project test riêng trên gói Free, ưu tiên Singapore. Không dùng dữ liệu nhân viên thật để kiểm thử hạ tầng.

Chạy lần lượt `backend/supabase/schema.sql` và `backend/supabase/003_runtime.sql` bằng SQL Editor hoặc CLI. Lấy Project URL và server secret/service-role key; chỉ đưa khóa này vào backend Render. API tự tạo bucket `attendance-photos` với `public=false`, giới hạn JPEG 5 MB và từ chối chạy nếu bucket đã bị công khai.

## Render

Tạo Blueprint từ repo và chọn `render.yaml`. Điền:

| Biến backend | Giá trị |
| --- | --- |
| `SUPABASE_URL` | URL HTTPS của project test |
| `SUPABASE_SECRET_KEY` | Secret/service-role key của project test |
| `FACE_CORS_ORIGINS` | URL HTTPS thực tế của Static Site, không có dấu `/` cuối |

Nếu tên miền chưa bị dùng, frontend dự kiến là `https://chamcongeco-test.onrender.com`. Luôn kiểm tra URL Render trả về; nếu có hậu tố, sửa `FACE_CORS_ORIGINS` đúng URL đó và redeploy backend. Không dùng CORS `*`. Hai khóa admin/kiosk được Render tạo riêng; lưu và bàn giao qua kênh riêng, không commit hoặc đặt trong `VITE_*`.

Docker build nhận `FACE_DOWNLOAD_MODELS=1`, tải đủ bốn model và xác minh SHA-256 trước khi tạo image. Khởi động dùng `$PORT`, một Uvicorn worker và một luồng CPU cho AI. Không cần chạy bước tải model sau deploy. Docker Compose tiếp tục dùng volume model như trước vì build arg mặc định là `0`.

Frontend dùng Bun 1.4.0/Node 24.14.0, tự chuẩn bị MediaPipe/model local và lấy `VITE_API_URL` từ URL backend trong Blueprint. Nếu tạo dịch vụ bằng CLI/API, phải cấu hình Dockerfile `backend/Dockerfile`, context repo root; frontend root `frontend`, build `bun install --frozen-lockfile && bun run build`, publish `dist`, cùng các biến, rewrite và headers trong Blueprint. Không truyền khóa Supabase hoặc khóa admin/kiosk vào frontend.

## Kiểm tra trước khi giao link

1. Chờ backend `/readyz` trả 200; health check này chỉ đạt sau khi nạp model, đọc gallery và kiểm tra bucket private.
2. Mở frontend HTTPS: đăng nhập admin và kiosk riêng; kiosk không được mở chức năng quản trị. Kiểm tra CORS từ đúng origin, camera và tài nguyên WASM/model.
3. Đăng ký một hồ sơ thử có đồng ý, chấm vào/ra, gửi lại cùng UUID để xác minh không ghi trùng. Kiểm tra ảnh chỉ đọc được bằng server secret.
4. Restart backend rồi kiểm tra hồ sơ, công, biên nhận UUID và ảnh vẫn còn ở Supabase. Không chấp nhận bản test nếu đang ghi SQLite hoặc ảnh lên filesystem Render.
5. Ghi lại thời gian xử lý và RAM trên Render; chưa có số đo cloud thì không suy ra từ benchmark local.

Backend Free có thể ngủ khi không hoạt động. Khi mở lại, chờ `https://<backend>/readyz` sẵn sàng trước khi nhập mã truy cập; màn đăng nhập có timeout ngắn hơn thời gian khởi động máy chủ. Theo dõi quota database, Storage, bandwidth/build; không nâng cấp gói trả phí tự động. Kiểm tra các hạn mức hiện hành tại [Render Free](https://render.com/docs/free) và [Supabase Pricing](https://supabase.com/pricing).

Giám sát UptimeRobot: tạo HTTP(s) monitor trỏ tới `https://<backend>/healthz`, chu kỳ 5 phút, timeout 60 giây. Endpoint hỗ trợ cả GET và HEAD (phương thức mặc định của HTTP monitor), không cần mã truy cập và không chạy nhận diện hoặc truy vấn DB cho mỗi lần kiểm tra. Monitor này kiểm tra tiến trình; `/readyz` tiếp tục kiểm tra model/gallery/kho dữ liệu cho Render. Request định kỳ giúp hạn chế ngủ do idle; không loại bỏ các giới hạn hoặc restart của gói Free.

Bản test chỉ dùng để nghiệm thu với ít người. Camera thật, độ chính xác nhận diện/chống giả mạo và tải đồng thời phải kiểm tra tại thiết bị khách hàng.
