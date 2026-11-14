import { Button, Checkbox, InlineNotification, TextInput } from '@carbon/react'
import { useEffect, useRef, useState } from 'react'
import { enrollEmployee } from '../services/api'
import { useCameraRecognition } from '../hooks/useCameraRecognition'

interface EnrollmentTabProps {
  onEnrolled: () => void
}

type SubmissionMessage = { type: 'success' | 'error'; text: string } | null

const ignoreAttendance = () => {}

function nameFromFilename(filename: string): string {
  const withoutExtension = filename.replace(/\.[^.]+$/, '')
  return withoutExtension
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

export function EnrollmentTab({ onEnrolled }: EnrollmentTabProps) {
  const [name, setName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [consented, setConsented] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [capturing, setCapturing] = useState(false)
  const [message, setMessage] = useState<SubmissionMessage>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const { cameraState, videoRef, error: cameraError, startCamera, stopCamera } = useCameraRecognition({
    action: 'in',
    recognitionEnabled: false,
    onAttendanceUpdated: ignoreAttendance,
  })
  const cameraOpen = cameraState === 'active' || cameraState === 'requesting'

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl)
    }
  }, [previewUrl])

  const selectFile = (selectedFile: File, prefillName = true) => {
    if (!['image/jpeg', 'image/png'].includes(selectedFile.type)) {
      setMessage({ type: 'error', text: 'Chọn ảnh JPG hoặc PNG.' })
      return
    }
    if (selectedFile.size > 5 * 1024 * 1024) {
      setMessage({ type: 'error', text: 'Ảnh phải có dung lượng tối đa 5 MB.' })
      return
    }
    setFile(selectedFile)
    setPreviewUrl(URL.createObjectURL(selectedFile))
    if (prefillName && !name.trim()) setName(nameFromFilename(selectedFile.name))
    setMessage(null)
  }

  const capturePhoto = async () => {
    const video = videoRef.current
    if (!video || video.readyState < 2 || !video.videoWidth || !video.videoHeight) {
      setMessage({ type: 'error', text: 'Chờ hình ảnh camera hiển thị trước khi chụp.' })
      return
    }
    const stream = video.srcObject
    setCapturing(true)
    setMessage(null)
    try {
      const canvas = document.createElement('canvas')
      canvas.width = Math.min(video.videoWidth, 1280)
      canvas.height = Math.round(canvas.width * video.videoHeight / video.videoWidth)
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Trình duyệt không thể xử lý ảnh camera.')
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.9),
      )
      if (videoRef.current !== video || video.srcObject !== stream) return
      if (!blob) throw new Error('Không thể chụp ảnh. Vui lòng thử lại.')
      selectFile(new File([blob], 'employee-photo.jpg', { type: 'image/jpeg' }), false)
      stopCamera()
    } catch (error) {
      setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Không thể chụp ảnh.' })
    } finally {
      setCapturing(false)
    }
  }

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!file || !name.trim() || !consented || submitting || cameraOpen || capturing) return
    setSubmitting(true)
    setMessage(null)
    try {
      const employee = await enrollEmployee(name.trim(), file)
      setMessage({
        type: 'success',
        text: `Đã đăng ký ${employee.name} · Mã ${employee.employee_id}.`,
      })
    } catch (error) {
      setMessage({
        type: 'error',
        text: error instanceof Error ? error.message : 'Không thể đăng ký nhân viên.',
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <section className="panel" aria-labelledby="enrollment-title">
      <div className="panel-header">
        <div>
          <h2 id="enrollment-title">Hồ sơ khuôn mặt</h2>
          <p>Điền tên, thêm ảnh rõ mặt và xác nhận đồng ý trước khi lưu.</p>
        </div>
        <span className="step-pill">Ảnh chỉ có một người</span>
      </div>

      <form onSubmit={handleSubmit}>
        <div className="form-grid">
          <div className="form-fields">
            <h3 className="form-section-title">1. Thông tin nhân viên</h3>
            <TextInput id="employee-name" labelText="Họ và tên" value={name}
              maxLength={120} placeholder="Ví dụ: Nguyễn Minh Anh" autoComplete="off"
              helperText="Kiểm tra họ tên được gợi ý từ tên tệp ảnh trước khi lưu."
              onChange={(event) => setName(event.target.value)} />
          </div>

          <div className="camera-column">
            <h3 className="form-section-title">2. Ảnh khuôn mặt</h3>
            <div className="camera-toolbar">
              <Button
                kind="tertiary"
                type="button"
                disabled={submitting || capturing || cameraState === 'requesting'}
                onClick={() => cameraState === 'active' ? void capturePhoto() : void startCamera()}
              >
                {cameraState === 'requesting' ? 'Đang mở camera…' : capturing ? 'Đang chụp…' : cameraState === 'active' ? 'Chụp ảnh' : previewUrl ? 'Chụp lại' : 'Mở camera'}
              </Button>
              {cameraOpen ? (
                <Button kind="tertiary" type="button" onClick={stopCamera}>
                  Hủy chụp
                </Button>
              ) : null}
            </div>
            {cameraError ? <InlineNotification kind="error" role="alert" title="Không thể mở camera" subtitle={cameraError} hideCloseButton lowContrast /> : null}
            <div className="camera-frame" style={{ display: cameraOpen ? undefined : 'none' }}>
              <video ref={videoRef} muted playsInline aria-label="Camera đăng ký trực tiếp" />
            </div>
            {!cameraOpen ? (
              <label
                className={`upload-zone${dragging ? ' dragging' : ''}${previewUrl ? ' has-preview' : ''}`}
                htmlFor="face-image"
                onDragEnter={(event) => {
                  event.preventDefault()
                  setDragging(true)
                }}
                onDragOver={(event) => event.preventDefault()}
                onDragLeave={() => setDragging(false)}
                onDrop={(event) => {
                  event.preventDefault()
                  setDragging(false)
                  const droppedFile = event.dataTransfer.files[0]
                  if (droppedFile) selectFile(droppedFile)
                }}
              >
                <input
                  ref={inputRef}
                  id="face-image"
                  type="file"
                  accept="image/jpeg,image/png,.jpg,.jpeg,.png"
                  onChange={(event) => {
                    const selectedFile = event.target.files?.[0]
                    if (selectedFile) selectFile(selectedFile)
                  }}
                />
                {previewUrl && file ? (
                  <>
                    <img className="image-preview" src={previewUrl} alt="Ảnh khuôn mặt nhân viên" />
                    <span className="preview-overlay">
                      <span>{file.name}</span>
                      <span>Đổi ảnh</span>
                    </span>
                  </>
                ) : (
                  <div className="upload-copy">
                    <span className="upload-icon" aria-hidden="true">
                      <svg viewBox="0 0 24 24">
                        <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M5 14.5V19h14v-4.5" />
                      </svg>
                    </span>
                    <strong>Kéo ảnh vào đây hoặc chọn tệp</strong>
                    <span>JPG hoặc PNG · Tối đa 5 MB</span>
                  </div>
                )}
              </label>
            ) : null}
          </div>
          <div className="enrollment-confirm">
            <h3 className="form-section-title">3. Xác nhận và lưu</h3>
            <div className="consent-box">
              <Checkbox id="employee-consent" checked={consented}
                onChange={(_, { checked }) => setConsented(checked)}
                labelText="Tôi xác nhận nhân viên đã đồng ý lưu dữ liệu sinh trắc học khuôn mặt để chấm công." />
            </div>
            <Button
              className="enrollment-submit"
              type="submit"
              disabled={!file || !name.trim() || !consented || submitting || cameraOpen || capturing}
            >
              {submitting ? <span className="spinner" /> : null}
              {submitting ? 'Đang đăng ký…' : 'Lưu nhân viên'}
            </Button>

            {message ? (
              <div className="submission-result">
                <InlineNotification kind={message.type} role={message.type === 'error' ? 'alert' : 'status'}
                  title={message.type === 'success' ? 'Đăng ký thành công' : 'Chưa thể đăng ký'}
                  subtitle={message.text} hideCloseButton lowContrast />
                {message.type === 'success' ? (
                  <Button kind="ghost" className="message-action" type="button" onClick={onEnrolled}>
                    Chuyển sang chấm công
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </form>
    </section>
  )
}
