# Chạy backend mới trên Render Pro gốc

Mục tiêu: giữ dịch vụ `https://chamcongeco.onrender.com`, repo `quantrinhansu123/chamcongeco`, nhánh `main`. Không tạo dịch vụ mới hoặc đổi gói Pro. Frontend đang ở `https://chamcongeco.vercel.app`.

## Settings cho runtime Python

| Trường | Giá trị |
| --- | --- |
| Repository | `https://github.com/quantrinhansu123/chamcongeco` |
| Branch | `main` |
| Runtime | Python |
| Root Directory | `backend` |
| Build Command | `bash scripts/render-build.sh` |
| Start Command | `bash scripts/render-start.sh` |
| Health Check Path | `/readyz` |

Build cài dependency từ lockfile, tải và kiểm tra checksum đủ bốn model ONNX. Bước tải model chỉ đọc cấu hình thư mục, không yêu cầu mã admin/kiosk hoặc thông tin DB, không kết nối DB và không chạy SQL. Start dùng một Uvicorn worker, `$PORT` do Render cấp và bắt buộc chế độ production. Có thể chạy script từ root repo bằng tiền tố `backend/`; mỗi script tự chuyển vào thư mục backend.

`backend/.python-version` chọn Python 3.12. Nếu service đang đặt `PYTHON_VERSION` khác 3.12, bỏ giá trị override đó hoặc chọn bản 3.12.x được Render hỗ trợ. Đặt `UV_VERSION=0.13.8` để dùng cùng phiên bản uv đã kiểm thử.

## Environment

Trong Render → Environment, nhập các biến dưới đây hoặc dùng Add from .env với file Environment riêng đã chuẩn bị ở máy bàn giao. Không commit file chứa giá trị thật.

```dotenv
APP_ENV=production
UV_VERSION=0.13.8
STORAGE_BACKEND=supabase
FACE_ENGINE=insightface
FACE_MODEL_DIR=models
FACE_CPU_THREADS=1
OMP_NUM_THREADS=1
OPENBLAS_NUM_THREADS=1
FACE_CORS_ORIGINS=https://chamcongeco.vercel.app
FACE_ADMIN_API_KEY=<ma-quan-tri-dai-toi-thieu-32-ky-tu>
FACE_KIOSK_API_KEY=<ma-tram-khac-ma-quan-tri>
SUPABASE_URL=https://<project-test>.supabase.co
SUPABASE_SECRET_KEY=<server-secret-cua-project-test>
```

File Environment bàn giao sử dụng Supabase test của bản mới đã có schema tương thích. Nó không sao chép hoặc thay đổi database gốc. Việc nhập file vào Render sẽ cấu hình backend Pro đọc/ghi project test này; kiểm tra đúng project trước khi Save. Mã quản trị và mã trạm được lưu riêng để nhập trên giao diện Vercel, không đưa vào `VITE_*`.

Nếu giữ Supabase gốc có schema cũ, redeploy riêng không tự tạo các cột/RPC của runtime mới. Hai script không thực hiện migration, reset, import hoặc thu lại mặt. Đồng bộ DB với Eco là giai đoạn riêng.

## Deploy và xác minh

Sau khi lưu Settings và Environment, chọn Manual Deploy → Deploy latest commit. Theo dõi bước model có thông báo `Verified four model files`. `/readyz` chỉ trả 200 sau khi nạp model, đọc gallery và kiểm tra Storage private thành công.

Kiểm tra `https://chamcongeco.onrender.com/readyz` trả `{"status":"ready"}`. `/api/session` không có mã phải trả 401; sau khi nhập đúng mã ở Vercel phải mở được ứng dụng. Tiếp tục thử camera, đăng ký mẫu mới, chấm vào/ra, retry và restart giữ dữ liệu trước khi bàn giao sử dụng.

Nếu Settings hiện dùng Docker, giữ Docker và dùng Dockerfile `backend/Dockerfile` với context repo root, đặt `FACE_DOWNLOAD_MODELS=1`, `FACE_MODEL_DIR=/models`; không dùng hai lệnh Bash native hoặc `FACE_MODEL_DIR=models` của cấu hình Python. Các biến auth, CORS và Supabase vẫn phải cấu hình đúng. Không áp Blueprint Free của repo demo lên dịch vụ Pro.
