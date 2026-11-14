# Đăng ký tự thu 5 góc

Mặc định đăng ký bằng camera sẽ tự chọn **thẳng → trái nhẹ → phải nhẹ → ngẩng nhẹ → cúi nhẹ**. Chọn đúng nhân viên khi cập nhật hồ sơ để giữ mã và lịch sử chấm công.

## Sử dụng

1. Điền họ tên và xác nhận nhân viên đồng ý lưu dữ liệu khuôn mặt.
2. Bấm **Bắt đầu thu 5 góc**, cho phép camera nếu trình duyệt yêu cầu. Lần đầu có thể phải tải bộ hướng dẫn; trạng thái tải được hiển thị.
3. Nhìn thẳng, quay nhẹ theo hướng dẫn. Mỗi góc cần giữ ổn định ít nhất 700 ms; không phải bấm Chụp ảnh. Mặt mờ/tối, quá xa/gần, bị cắt, nhắm mắt hoặc nhiều người sẽ được nhắc chỉnh lại.
4. Server kiểm tra từng ảnh đã chọn và đối chiếu với ảnh nhìn thẳng. Chỉ ảnh đạt mới được tính vào **Đã kiểm tra X/5 góc**. Ảnh chưa đạt được tự thu lại; không phải đợi đến khi lưu mới phát hiện mờ. Đủ 5 góc thì camera tự dừng. Xem các thumbnail, bấm **Chụp lại** ở đúng góc cần thay hoặc **Thu lại 5 góc** để bắt đầu lại. Bấm **Lưu nhân viên** sau khi xem lại.
5. Nếu backend từ chối một ảnh, ô góc tương ứng được đánh dấu. Chụp lại góc đó trước khi lưu; không cần thu lại toàn bộ. Đổi người giữa các ảnh sẽ bị backend từ chối khi vector không nhất quán.

**Dừng thu** giữ các ảnh đã chọn để tiếp tục. Chuyển màn hình/ẩn tab sẽ dừng camera và worker. Đổi sang **Tải ảnh lên** bỏ bộ ảnh chưa lưu và cho chọn 1–5 JPG/PNG có sẵn; dùng khi thiết bị không hỗ trợ tracker hoặc camera bị từ chối.

## Cách hoạt động

- MediaPipe Tasks Face Landmarker 1.2.3 chạy CPU trong module Web Worker, tối đa 2 mặt để phát hiện người thứ hai. Bật transformation matrix, tắt blendshapes. Browser phân tích ảnh thu nhỏ tối đa 640 px, giữ bản gốc tối đa 1280 px để chọn ảnh.
- Một frame đang xử lý; timestamp video mới và giới hạn nhịp gửi khoảng 9 frame/giây, thích ứng theo thời gian xử lý. Không xếp hàng dài; không chọn 5 ảnh bằng timer cố định.
- Chỉ chọn mẫu khi pose và chất lượng đạt liên tục 700 ms, ít nhất 5 frame; bỏ 200 ms/2 frame đầu sau chuyển động trước khi chọn mẫu. Khoảng đứt lớn/rung sẽ reset. Điểm xếp hạng ưu tiên chi tiết qua log(sharpness), phạt lệch sáng nhẹ, không bão hòa mọi ảnh trên ngưỡng 1000 thành cùng điểm. JPEG lấy từ **đúng frame đã được đánh giá**, không từ khung mới sau khi worker trả kết quả.
- Preview được mirror để dễ nhìn; ảnh phân tích/embedding giữ nguyên chiều gốc. Nhãn trái/phải theo người đứng trước camera. Mẫu thẳng được dùng làm mốc tương đối cho các góc tiếp theo.
- Worker không gửi hình lên dịch vụ ngoài. Sau khi chọn một ảnh, app gửi JPEG đó và ảnh nhìn thẳng tham chiếu (nếu đã có) đến **server của hệ thống** qua endpoint admin; không gửi video liên tục. Kiểm tra không ghi DB/ảnh, không trả embedding, không lưu ảnh tham chiếu giữa các request. Chụp lại góc thẳng cũng so với ảnh thẳng cũ để giữ cùng người với các ô đã thu.
- Mỗi browser có tối đa một request kiểm tra ảnh đang chạy; server chỉ nhận một preflight đồng thời mỗi process, trả 429 khi bận, inference vẫn dùng khóa chung. Lỗi chất lượng/khác người: tối đa 8 lần chọn ảnh/góc, thời hạn 60 giây. Request tối đa 10 giây; lỗi mạng/429/502/503/504 thử lại cùng ảnh tối đa 2 lần, chờ 1 rồi 2 giây. Request đang chạy có thể kết thúc sau thời hạn góc tối đa 10 giây; không bắt đầu retry mới khi hết hạn. Hết giới hạn dừng camera và giữ các ảnh đã đạt để tiếp tục hoặc **Thu lại từ đầu**.
- Camera được yêu cầu focus/exposure `continuous` nếu `getCapabilities()` hỗ trợ. Lỗi driver được bỏ qua, tối đa chờ 1.2 giây mỗi điều khiển; nếu driver treo thì không gửi lệnh tiếp theo. Webcam fixed-focus và trình duyệt thiếu API vẫn dùng được. Sau khi cấu hình, chờ camera ổn định 800 ms; không chỉnh nét/gamma/beautify ảnh.
  Luồng chấm công cũng dùng helper cấu hình camera này; ảnh chưa đạt chất lượng tiếp tục được từ chối và hiển thị hướng dẫn, không phục chế để bỏ qua PAD.
- Chỉ khi quản trị xác nhận lưu, app gửi cả bộ 5 JPEG. Backend **kiểm tra lại toàn bộ** consent, pose, số mặt, chất lượng, cùng người và trùng hồ sơ rồi mới lưu nguyên tử. Kết quả preflight không phải vé bỏ qua kiểm tra cuối. PAD/embedding/ảnh minh chứng vẫn nhận ảnh gốc không phục chế AI.

**Quality policy `face-quality-v2`** do server cung cấp qua GET `/api/enrollment/policy`: ROI 128×128, float luminance R×0.299+G×0.587+B×0.114, variance Laplacian 4 láng giềng bỏ biên; mặc định nét >=40, sáng 45–220, kích thước mặt gốc >=80 px. Trình duyệt lấy policy trước khi khởi tạo worker, không có ngưỡng nét dự phòng riêng. Đăng ký, kiểm tra trước lưu và chấm công dùng chung `runtime/quality.py`. Điều chỉnh qua `FACE_MIN_SHARPNESS`, `FACE_MIN_BRIGHTNESS`, `FACE_MAX_BRIGHTNESS`, `FACE_MIN_FACE_PIXELS`; khởi động lại API để áp dụng. **Ngưỡng nét cũ đo ở độ phân giải gốc đã đổi ý nghĩa: phải hiệu chuẩn lại giá trị từng được chỉnh tay.** Không hạ ngưỡng chỉ để thu đủ ảnh nhanh.

Bbox MediaPipe và SCRFD, resize/canvas và nén JPEG vẫn khác nhau nên không hứa điểm số pixel trùng tuyệt đối. Kiểm tra browser là hướng dẫn sớm; server quyết định từng mẫu và quyết định cuối khi lưu. Cả hai dùng cùng công thức/ngưỡng; golden pixel fixture được kiểm tra ở Python và TypeScript. Pose và các giới hạn bố cục/nhắm mắt nằm trong `frontend/src/enrollment/{pose,quality}.ts`. Những người không thể thực hiện tư thế có thể dùng ảnh có sẵn với quản trị hỗ trợ.

## Tài nguyên và đóng gói

`bun run prepare:vision` chuẩn bị tài nguyên (dev/build tự gọi):

- `public/vision/face-landmarker-64184e229b263107.task`, 3,758,596 byte, SHA-256 `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`.
- `public/vision/tasks-vision-1.2.3/vision_wasm_module_internal.{js,wasm}`, copy từ SDK đã pin và kiểm tra checksum. Binary WASM khoảng 14 MiB chưa nén.

Lần chuẩn bị đầu cần Internet; cache đã xác minh có thể dùng lại offline. Tài nguyên không đưa lên Git; Docker build chuẩn bị chúng trong image. Nginx gzip/cache tài nguyên có phiên bản. Không nạp model vào browser ở mỗi lượt chấm công.

Module worker cần `FilesetResolver.forVisionTasks(path, true)`. Vite có middleware chỉ phục vụ ba tài nguyên đã pin trước source transforms, vì import động WASM loader từ `public` với `?import` sẽ bị Vite từ chối. Production phục vụ static bằng Nginx.

CSP cho phép `script-src 'self' 'wasm-unsafe-eval'` và `worker-src 'self'`; không mở JavaScript `unsafe-eval`, không cho phép CDN tùy ý. Tất cả tài nguyên model đến từ cùng origin.

## Hợp đồng API

GET `/api/enrollment/policy` yêu cầu admin, trả phiên bản và ngưỡng chất lượng. POST `/api/enrollment/validate` yêu cầu admin + consent, nhận `image`, `pose` và `reference` (bắt buộc cho góc khác front). Trả `valid`, `pose`, `reference_checked`, `quality`; không tạo nhân viên/lượt công hay trả vector. Lỗi thiếu ảnh tham chiếu `reference_required`; tham chiếu không hợp lệ `reference_invalid` cần thu lại từ đầu; lỗi chất lượng/khác người tự thu lại. `Retry-After: 1` có trên phản hồi 429/503.

POST `/api/employees` và PUT `/api/employees/{id}/face` giữ trường `name`, `consent`, nhiều trường file `image`. Luồng guided bổ sung:

```text
capture_mode=guided
pose_labels=["front","left","right","up","down"]
```

Guided bắt buộc đủ 5 ảnh theo thứ tự. Upload vẫn nhận 1–5 ảnh. Lỗi liên quan ảnh có `image_index` (0–4) để chụp lại đúng ô. Metadata pose từ browser chỉ hỗ trợ chất lượng; backend không coi nhãn client gửi là chứng thực an ninh. Không cần migration database mới.

## Kiểm chứng và giới hạn

Unit test kiểm tra pose toán học, chất lượng và điều kiện giữ ổn định. Browser test dùng fake camera/pose để kiểm tra tự thu đủ 5 góc, retake, không gửi hồ sơ khi chưa xác nhận, không queue frame và dọn tài nguyên khi hủy/đổi màn hình. Smoke riêng dùng **MediaPipe thật** qua UI để kiểm tra worker, tải tài nguyên cùng origin và inference.

CI kiểm tra cả Vite và image production/Nginx với CSP thật. Các kiểm tra này không thay thế thử 5 góc bằng webcam vật lý, Safari/iOS, ánh sáng/kính và người thật.

Job frontend dùng `SMOKE_MOCK_API=1` cho smoke worker: thay API session/danh sách/policy vì job này không khởi động backend; SDK/WASM/model vẫn thật. Job Compose chạy smoke với backend thật và không bật biến này. `backend/scripts/verify_enrollment.py` kiểm tra CPU ONNX thật, ảnh gốc/phóng lớn, ảnh mờ, khác người (nếu truyền `--other`), preflight không ghi dữ liệu và lưu cuối trong SQLite tạm; không dùng database vận hành.

**Thu đủ góc không chứng minh người thật hoặc chống replay.** Endpoint đăng ký vẫn hỗ trợ ảnh quản trị tải lên và dùng kiểm tra chất lượng/danh tính; không tuyên bố có enrollment liveness. MiniFASNet tiếp tục bảo vệ luồng chấm công theo giới hạn đã ghi trong `VERIFICATION.md`.
