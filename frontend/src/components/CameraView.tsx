import { Button } from '@carbon/react'
import type { RefObject } from 'react'
import type {
  CameraState,
  RecognitionState,
  RecognizedFace,
} from '../types/face'

interface CameraViewProps {
  videoRef: RefObject<HTMLVideoElement | null>
  cameraState: CameraState
  recognitionState: RecognitionState
  faces: RecognizedFace[]
  frameSize: { width: number; height: number }
  error: string | null
  hasEmployees: boolean
  actionLabel: string
  actionDisabled: boolean
  hasResult: boolean
  onStart: () => void
  onStop: () => void
}

const cameraLabels: Record<CameraState, { title: string; detail: string }> = {
  idle: { title: 'Camera đang tắt', detail: 'Chỉ mở khi bạn bấm nút chấm công' },
  requesting: { title: 'Đang mở camera', detail: 'Chờ bạn cấp quyền trong trình duyệt' },
  active: { title: 'Camera đang bật', detail: 'Giữ khuôn mặt rõ trong khung hình' },
  'permission-denied': { title: 'Chưa có quyền camera', detail: 'Chọn Luôn cho phép camera trong cài đặt trang web' },
  unavailable: { title: 'Không thể mở camera', detail: 'Kiểm tra kết nối camera' },
}

function recognitionMessage(
  state: RecognitionState,
  faces: RecognizedFace[],
  hasEmployees: boolean,
  error: string | null,
) {
  if (!hasEmployees) return 'Đăng ký nhân viên trước khi chấm công.'
  if (state === 'recognizing') return 'Đang nhận diện khuôn mặt…'
  if (state === 'recognized') {
    const names = [...new Set(faces.filter((face) => face.employee_id).map((face) => face.name))]
    return `Đã nhận diện: ${names.join(', ')}`
  }
  if (state === 'unknown') return 'Chưa nhận ra nhân viên. Nhìn thẳng vào camera hoặc đăng ký khuôn mặt.'
  if (state === 'no-face') return 'Đưa khuôn mặt vào khung hình để chấm công.'
  if (state === 'spoof-detected') {
    return error ?? 'Phát hiện ảnh hoặc màn hình. Hãy dùng khuôn mặt thật; chưa ghi nhận chấm công.'
  }
  if (state === 'backend-error') return error ?? 'Không thể kết nối máy chủ nhận diện.'
  return 'Nhận diện tự động sau khi bạn bật camera.'
}

export function CameraView({
  videoRef,
  cameraState,
  recognitionState,
  faces,
  frameSize,
  error,
  hasEmployees,
  actionLabel,
  actionDisabled,
  hasResult,
  onStart,
  onStop,
}: CameraViewProps) {
  const cameraLabel = cameraLabels[cameraState]
  const isError = ['permission-denied', 'unavailable'].includes(cameraState)

  return (
    <div className="camera-column">
      <div className="camera-toolbar">
        <div className="camera-status">
          <span
            className={`status-indicator${cameraState === 'active' ? ' active' : ''}${isError ? ' error' : ''}`}
          />
          <span>
            <strong>{cameraLabel.title}</strong>
            <span>{cameraLabel.detail}</span>
          </span>
        </div>
        {cameraState === 'active' ? (
          <Button kind="tertiary" type="button" onClick={onStop}>
            Dừng chấm công
          </Button>
        ) : (
          <Button
            className="attendance-button"
            type="button"
            disabled={cameraState === 'requesting' || actionDisabled}
            onClick={() => void onStart()}
          >
            {cameraState === 'requesting' ? 'Đang mở camera…' : actionLabel}
          </Button>
        )}
        {hasResult ? <Button kind="ghost" type="button" onClick={onStop}>Chấm công người khác</Button> : null}
      </div>

      <div
        className={`camera-frame${recognitionState === 'spoof-detected' ? ' spoof-detected' : ''}`}
        style={{ aspectRatio: `${frameSize.width} / ${frameSize.height}` }}
      >
        <video ref={videoRef} muted playsInline aria-label="Camera chấm công trực tiếp" />
        {cameraState !== 'active' ? (
          <div className="camera-placeholder">
            <div>
              <span className="placeholder-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M4 7.5h11.5v9H4zM15.5 10l4.5-2.5v9L15.5 14" />
                </svg>
              </span>
              <strong>{hasResult ? 'Đã nhận diện khuôn mặt' : cameraLabel.title}</strong>
              <p>{error ?? (hasResult ? 'Camera đã dừng. Kiểm tra kết quả chấm công bên dưới.' : 'Bấm nút chấm công, cho phép camera và nhìn thẳng vào ống kính.')}</p>
            </div>
          </div>
        ) : null}

        {cameraState === 'active' ? (
          <div className="detection-layer" aria-hidden="true">
            {faces.map((face, index) => {
              const top = (face.location.top / frameSize.height) * 100
              const left = (face.location.left / frameSize.width) * 100
              const width =
                ((face.location.right - face.location.left) / frameSize.width) * 100
              const height =
                ((face.location.bottom - face.location.top) / frameSize.height) * 100
              return (
                <div
                  className={`face-box${face.employee_id ? '' : ' unknown'}`}
                  key={`${face.location.left}-${face.location.top}-${index}`}
                  style={{ top: `${top}%`, left: `${left}%`, width: `${width}%`, height: `${height}%` }}
                >
                  <span className="face-label">
                    {face.employee_id ? face.name : 'Chưa nhận diện'}
                  </span>
                </div>
              )
            })}
          </div>
        ) : null}
        {cameraState === 'active' && recognitionState === 'spoof-detected' ? (
          <div className="spoof-warning" role="alert">
            <strong>Phát hiện ảnh hoặc màn hình</strong>
            <span>Hãy dùng khuôn mặt thật. Chưa ghi nhận chấm công.</span>
          </div>
        ) : null}
      </div>

      <div className="recognition-strip" role="status">
        {recognitionState === 'recognizing' ? <span className="spinner" /> : null}
        <strong>Nhận diện</strong>
        <span>{recognitionMessage(recognitionState, faces, hasEmployees, error)}</span>
      </div>
      <p>Để trình duyệt nhớ quyền camera, chọn “Luôn cho phép” cho địa chỉ web này.
        Ảnh được tự lưu riêng cho mỗi lần vào và ra thành công.</p>
    </div>
  )
}
