# Attendly UI

React 19 + TypeScript + Vite + IBM Carbon, Inter local. Không nhúng API key vào mã nguồn hoặc biến VITE.

```bash
bun install --frozen-lockfile
bun run dev --host 127.0.0.1
```

Backend phải chạy ở `127.0.0.1:8000`; Vite proxy `/api`. Với Docker, Nginx phục vụ cùng origin và chuyển API đến container nội bộ.

```bash
bun run lint
bun run test:unit
bun run build
bunx playwright install chromium
# Với dev server đang chạy:
node --test --test-concurrency=1 tests/*.mjs
node scripts/smoke-enrollment-worker.mjs
```

Windows dùng Edge: `$env:PLAYWRIGHT_CHANNEL='msedge'`. Test dùng camera/API giả; không đánh giá nhận diện sinh trắc học. [Hướng dẫn đầy đủ](../README.md).

Auto enrollment mặc định tự chọn 5 góc, không yêu cầu bấm chụp từng ảnh. MediaPipe chạy trong worker, được nạp khi bắt đầu cùng quality policy từ server. Mỗi ảnh đã chọn được kiểm tra trên backend trước khi đánh dấu đạt; góc chưa đạt tự được thu lại trong giới hạn. Request chỉ chứa ảnh đã chọn và ảnh thẳng tham chiếu, không stream live video. Toàn bộ 5 ảnh được gửi lại để kiểm tra/lưu nguyên tử khi quản trị xác nhận. Có autofocus/exposure theo khả năng thiết bị, fallback khi không hỗ trợ. `bun run dev`/`build` chuẩn bị tài nguyên cùng origin, pin SHA-256. Không commit `public/vision/` hoặc ảnh camera. [Chi tiết](../docs/AUTO_ENROLLMENT.md), [bàn giao](../docs/HANDOVER.md).
