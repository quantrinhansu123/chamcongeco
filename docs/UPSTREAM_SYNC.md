# Đồng bộ bản phát triển về repo gốc

Ngày 15/11/2026. Nguồn ứng dụng: `huybitvvt/chamcongeco-next`, commit `8e4fe8f14a680dc0a003877753b623876cdb5c00`. Đích: `quantrinhansu123/chamcongeco`, nhánh `main`. Giữ lịch sử Git gốc, không merge hai lịch sử độc lập.

## Phạm vi lần này

- Đồng bộ frontend Carbon, thu mặt 5 góc/preflight, backend ONNX, biên nhận UUID, phân quyền admin/kiosk, kiểm thử, Docker và tài liệu.
- Không chạy sao lưu, migration, reset, import, xóa hoặc chuyển dữ liệu trên database nào. Không chuyển dữ liệu của demo Free vào database gốc, không thu lại hồ sơ mặt cũ.
- Không thay đổi cấu hình, URL, gói trả phí hoặc biến môi trường của dịch vụ Vercel/Render Pro trong dashboard.
- Không đưa `.env`, mã truy cập, ảnh/vector, database local hoặc trọng số model từ máy phát triển vào commit. Các tệp prototype đã được theo dõi trong repo gốc được giữ nguyên trong lần đồng bộ mã này.
- Không đặt `render.yaml` Free của repo phát triển tại root repo gốc. Cấu hình đó chỉ dành cho demo riêng; không áp dụng nó lên dịch vụ Pro.
- Chưa thực hiện kết nối tài khoản, nhân viên hoặc bảng công với web Eco.

## Khi triển khai dịch vụ gốc

Vercel hiện phục vụ frontend tại `https://chamcongeco.vercel.app` và frontend gọi API gốc `https://chamcongeco.onrender.com`. Giữ `VITE_API_URL` trỏ đúng backend gốc. Frontend root là `frontend`, lệnh build là `bun run build` sau khi cài dependency theo lockfile, output `dist`. Build có bước chuẩn bị model/WASM phục vụ cùng origin.

Backend dùng entrypoint `backend.main:app`, một Uvicorn worker. Model phải được chuẩn bị bằng `python scripts/download_models.py` (từ root `backend`) trong bước build hoặc bằng một bước chuẩn bị đã được cấu hình; model được kiểm tra checksum trước khi phục vụ. Nếu dùng Docker, Dockerfile là `backend/Dockerfile`, context là repo root, build arg `FACE_DOWNLOAD_MODELS=1`.

Đã có hai script dành cho Render Python: `scripts/render-build.sh` và `scripts/render-start.sh` (Root Directory `backend`). Xem [hướng dẫn thao tác Render Pro](RENDER_PRO.md) cho các trường Settings và Environment; build chuẩn bị model độc lập với thông tin đăng nhập runtime.

Đối chiếu biến môi trường trong `backend/.env.example`: `APP_ENV=production`, hai mã `FACE_ADMIN_API_KEY`/`FACE_KIOSK_API_KEY` khác nhau, `FACE_CORS_ORIGINS` có origin frontend thực tế, `STORAGE_BACKEND` và thông tin kho dữ liệu đúng. Không đưa khóa quản trị hoặc Supabase secret vào biến `VITE_*`. `/healthz` hỗ trợ GET/HEAD; health check sẵn sàng là `/readyz`.

**Database có sẵn không đồng nghĩa đã tương thích với runtime mới.** Nếu dùng `STORAGE_BACKEND=supabase`, runtime cần các cột model/profile và RPC được định nghĩa trong `backend/supabase/003_runtime.sql`. Lần đồng bộ mã này không thực thi SQL đó. Redeploy riêng sẽ không tự bổ sung schema; backend có thể chưa khởi động được nếu database đang dùng schema cũ. Giữ điều kiện này rõ khi bàn giao, không ghi nhận bản Pro đã chạy đạt chỉ vì mã đã lên GitHub.

Khi được triển khai, kiểm tra đúng commit ở Vercel và Render, `/readyz`, đăng nhập admin/kiosk, đăng ký mẫu mới, chấm công, retry UUID và giữ dữ liệu sau restart. Sau khi bản gốc chạy đạt mới tiếp tục tích hợp web Eco.
