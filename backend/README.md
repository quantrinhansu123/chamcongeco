# Attendly API

Entrypoint: `backend.main:app`. Runtime mới ở `src/backend/runtime/`; prototype cũ được giữ để regression/đối chiếu, không phải cấu hình triển khai.

Từ thư mục gốc:

```bash
uv sync --project backend --frozen
uv run --project backend python backend/scripts/download_models.py
uv run --project backend uvicorn backend.main:app --host 127.0.0.1 --port 8000 --workers 1
```

Hoặc từ thư mục `backend`: `uv run uvicorn backend.main:app --host 127.0.0.1 --workers 1`.

Đọc [README gốc](../README.md), [vận hành](../docs/OPERATIONS.md), [chuyển dữ liệu](../docs/MIGRATION.md), [kiểm chứng](../docs/VERIFICATION.md). API tải cấu hình từ `backend/.env`, ưu tiên biến môi trường; không tải model tự động khi phục vụ.

Quality `face-quality-v2` dùng ROI 128×128; `FACE_MIN_SHARPNESS` cũ đo ở crop native cần hiệu chuẩn lại. GET `/api/enrollment/policy` và POST `/api/enrollment/validate` yêu cầu admin; preflight kiểm tra ảnh/cùng người mà không ghi DB hay trả vector. Đăng ký và chấm công dùng chung chất lượng ảnh gốc, vẫn kiểm tra lại ở lần lưu cuối. Xem [tự thu ảnh](../docs/AUTO_ENROLLMENT.md), [bàn giao](../docs/HANDOVER.md).
