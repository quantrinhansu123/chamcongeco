import { Button, Checkbox, InlineNotification, TextInput } from '@carbon/react'
import { useEffect, useRef, useState } from 'react'
import { ApiError, enrollEmployee } from '../services/api'
import { useAutoEnrollment } from '../hooks/useAutoEnrollment'
import { POSES } from '../enrollment/types'
import type { PoseId } from '../enrollment/types'
import type { EmployeeAttendance } from '../types/face'
import { AutoCapturePanel } from './AutoCapturePanel'

interface Props { onEnrolled: () => void; employee?: EmployeeAttendance | null }
type Message = { type: 'success' | 'error'; text: string } | null

export function EnrollmentTab({ onEnrolled, employee }: Props) {
  const [name, setName] = useState(employee?.name ?? '')
  const [mode, setMode] = useState<'guided' | 'upload'>('guided')
  const [files, setFiles] = useState<File[]>([])
  const [urls, setUrls] = useState<string[]>([])
  const [consented, setConsented] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState<Message>(null)
  const [invalidIndex, setInvalidIndex] = useState<number | null>(null)
  const submissionRef = useRef<AbortController | null>(null)
  const submittingRef = useRef(false)
  const invalidPhotoRef = useRef<File | null>(null)
  const camera = useAutoEnrollment()
  const cameraBusy = camera.state === 'loading' || camera.state === 'capturing' || camera.state === 'checking'
  const complete = POSES.every(pose => camera.photos[pose.id])
  const success = message?.type === 'success'

  useEffect(() => {
    const preview = files.map(file => URL.createObjectURL(file))
    // Preview URLs are an external resource tied to the chosen files.
    // oxlint-disable-next-line react/set-state-in-effect
    setUrls(preview)
    return () => preview.forEach(url => URL.revokeObjectURL(url))
  }, [files])
  useEffect(() => () => submissionRef.current?.abort(), [])
  const badPhoto = invalidIndex === null ? undefined : camera.photos[POSES[invalidIndex].id]
  useEffect(() => {
    if (mode === 'guided' && badPhoto && badPhoto.file !== invalidPhotoRef.current) {
      // Validation belongs to the selected image; a completed retake replaces it.
      // oxlint-disable-next-line react/set-state-in-effect
      setInvalidIndex(null)
      setMessage(null)
    }
  }, [badPhoto, mode])

  const selectFiles = (selected: File[]) => {
    if (submitting || success) return
    if (files.length + selected.length > 5) { setMessage({ type: 'error', text: 'Chọn tối đa 5 ảnh. Xóa ảnh cũ để thay thế.' }); return }
    if (selected.some(file => !['image/jpeg', 'image/png'].includes(file.type) || file.size > 5 * 1024 * 1024 || file.size === 0)) {
      setMessage({ type: 'error', text: 'Chọn ảnh JPG/PNG không rỗng, tối đa 5 MB mỗi ảnh.' }); return
    }
    setFiles(previous => [...previous, ...selected]); setMessage(null); setInvalidIndex(null)
    if (!name.trim() && selected[0]) setName(selected[0].name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/\b\w/g, letter => letter.toUpperCase()))
  }

  const changeMode = (next: typeof mode) => {
    if (submitting || next === mode) return
    camera.clear(); setFiles([]); setMessage(null); setInvalidIndex(null); setMode(next)
  }
  const start = (pose?: PoseId, restart?: boolean) => {
    if (!name.trim() || !consented || submitting || success) return
    setMessage(null)
    if (restart) setInvalidIndex(null)
    void camera.start(pose, restart)
  }

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim() || !consented || submittingRef.current || cameraBusy || success || invalidIndex !== null) return
    const selected = mode === 'guided' ? POSES.flatMap(pose => camera.photos[pose.id] ? [camera.photos[pose.id]!.file] : []) : files
    if (!selected.length || mode === 'guided' && selected.length !== 5) return
    const controller = new AbortController()
    submissionRef.current = controller
    submittingRef.current = true
    setSubmitting(true); setMessage(null)
    try {
      const saved = await enrollEmployee(name.trim(), selected, employee?.employee_id, controller.signal, mode === 'guided' ? POSES.map(pose => pose.id) : undefined)
      if (!controller.signal.aborted) setMessage({ type: 'success', text: `Đã lưu ${saved.name} · Mã ${saved.employee_id} · ${saved.template_count} ảnh khuôn mặt.` })
    } catch (error) {
      if (!controller.signal.aborted) {
        const index = error instanceof ApiError && error.imageIndex !== null && error.imageIndex < selected.length ? error.imageIndex : null
        invalidPhotoRef.current = index === null ? null : selected[index]
        setInvalidIndex(index)
        setMessage({ type: 'error', text: error instanceof Error ? error.message : 'Không lưu được hồ sơ. Vui lòng thử lại.' })
      }
    } finally { submittingRef.current = false; if (!controller.signal.aborted) setSubmitting(false) }
  }

  return <section className="panel" aria-labelledby="enrollment-title">
    <div className="panel-header"><div>
      <h2 id="enrollment-title">{employee ? `Cập nhật khuôn mặt · ${employee.employee_id}` : 'Hồ sơ khuôn mặt'}</h2>
      <p>{employee ? 'Cập nhật ảnh nhận diện, giữ nguyên mã nhân viên và lịch sử chấm công.' : 'Tự thu 5 góc bằng camera hoặc chọn ảnh có sẵn để đăng ký.'}</p>
    </div><span className="step-pill">Một người mỗi lượt</span></div>
    <form onSubmit={event => void submit(event)}>
      <div className="form-grid">
        <div className="form-fields">
          <h3 className="form-section-title">1. Thông tin và đồng ý</h3>
          <TextInput id="employee-name" labelText="Họ và tên" value={name} readOnly={!!employee} disabled={submitting || cameraBusy || success}
            maxLength={120} placeholder="Ví dụ: Nguyễn Minh Anh" autoComplete="off"
            helperText="Kiểm tra họ tên trước khi bắt đầu thu ảnh." onChange={event => setName(event.target.value)} />
          <div className="consent-box enrollment-consent"><Checkbox id="employee-consent" checked={consented} disabled={submitting || cameraBusy || success}
            onChange={(_, { checked }) => setConsented(checked)} labelText="Tôi xác nhận nhân viên đã đồng ý lưu dữ liệu sinh trắc học khuôn mặt để chấm công." /></div>
          <div className="capture-method" role="group" aria-label="Cách thêm ảnh khuôn mặt">
            <Button kind={mode === 'guided' ? 'primary' : 'tertiary'} type="button" aria-pressed={mode === 'guided'} disabled={submitting || success} onClick={() => changeMode('guided')}>Camera tự động</Button>
            <Button kind={mode === 'upload' ? 'primary' : 'tertiary'} type="button" aria-pressed={mode === 'upload'} disabled={submitting || success} onClick={() => changeMode('upload')}>Tải ảnh lên</Button>
          </div>
          <p className="enrollment-help">{mode === 'guided' ? 'Bắt đầu một lần, quay nhẹ theo chỉ dẫn. Hệ thống tự chọn ảnh rõ cho từng góc.' : 'Chọn 1–5 ảnh cùng người, rõ mặt và đủ sáng. Có thể dùng khi camera không khả dụng.'}</p>
        </div>
        <div className="camera-column">
          <h3 className="form-section-title">2. {mode === 'guided' ? 'Tự thu 5 góc khuôn mặt' : 'Ảnh khuôn mặt'}</h3>
          {mode === 'guided' ? <AutoCapturePanel {...camera} disabled={!name.trim() || !consented || submitting || success} invalidIndex={invalidIndex} onStart={start} /> : <>
            <label className={`upload-zone${dragging ? ' dragging' : ''}`} htmlFor="face-image"
              onDragEnter={event => { event.preventDefault(); setDragging(true) }} onDragOver={event => event.preventDefault()}
              onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); selectFiles(Array.from(event.dataTransfer.files)) }}>
              <input id="face-image" type="file" multiple disabled={submitting || success || files.length >= 5} accept="image/jpeg,image/png,.jpg,.jpeg,.png"
                onChange={event => { selectFiles(Array.from(event.target.files ?? [])); event.target.value = '' }} />
              <div className="upload-copy"><strong>Kéo ảnh vào đây hoặc chọn tệp</strong><span>1–5 ảnh JPG/PNG · Tối đa 5 MB mỗi ảnh</span></div>
            </label>
            <ol className="upload-previews" aria-label="Ảnh đã chọn">{files.map((file, index) => <li key={`${file.name}-${index}`} className={invalidIndex === index ? 'invalid' : undefined}>
              {urls[index] ? <img src={urls[index]} alt={`Ảnh khuôn mặt nhân viên ${index + 1}`} /> : null}
              <span>{file.name}{invalidIndex === index ? ' · Cần thay ảnh này' : ''}</span>
              <Button kind="ghost" size="sm" type="button" disabled={submitting || success} aria-label={`Xóa ảnh ${index + 1}`} onClick={() => { setFiles(files.filter((_, i) => i !== index)); setInvalidIndex(null); setMessage(null) }}>Xóa</Button>
            </li>)}</ol>
          </>}
        </div>
        <div className="enrollment-confirm">
          <h3 className="form-section-title">3. Kiểm tra và lưu</h3>
          <p>{mode === 'guided' ? 'Thu đủ 5 góc và kiểm tra các ảnh trước khi lưu. Có thể chụp lại từng góc.' : 'Kiểm tra các ảnh và họ tên trước khi lưu.'}</p>
          <Button className="enrollment-submit" type="submit" disabled={!name.trim() || !consented || submitting || success || cameraBusy || invalidIndex !== null || (mode === 'guided' ? !complete : !files.length)}>
            {submitting ? 'Đang lưu hồ sơ…' : 'Lưu nhân viên'}
          </Button>
          {message ? <div className="submission-result"><InlineNotification kind={message.type} role={message.type === 'error' ? 'alert' : 'status'}
            title={message.type === 'success' ? 'Đăng ký thành công' : 'Chưa thể lưu hồ sơ'} subtitle={message.text} hideCloseButton lowContrast />
            {success ? <><Button kind="ghost" type="button" className="message-action" onClick={onEnrolled}>Chuyển sang chấm công</Button>
              {!employee ? <Button kind="ghost" type="button" onClick={() => { camera.clear(); setName(''); setFiles([]); setConsented(false); setMessage(null); setInvalidIndex(null); document.getElementById('employee-name')?.focus() }}>Đăng ký người tiếp theo</Button> : null}</> : null}
          </div> : null}
        </div>
      </div>
    </form>
  </section>
}
