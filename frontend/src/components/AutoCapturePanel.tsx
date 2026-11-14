import { Button, InlineNotification } from '@carbon/react'
import { POSES } from '../enrollment/types'
import type { PoseId } from '../enrollment/types'
import type { useAutoEnrollment } from '../hooks/useAutoEnrollment'

interface Props extends Omit<ReturnType<typeof useAutoEnrollment>, 'start' | 'clear'> {
  disabled: boolean
  invalidIndex: number | null
  onStart: (pose?: PoseId, restart?: boolean) => void
}

export function AutoCapturePanel({ photos, state, target, progress, hint, error, frameSize, videoRef, stop, disabled, invalidIndex, onStart }: Props) {
  const busy = state === 'loading' || state === 'capturing' || state === 'checking'
  const count = POSES.filter(pose => photos[pose.id]).length
  const activePose = POSES.find(pose => pose.id === target) ?? POSES[0]
  return <div className="auto-capture" data-capture-state={state}>
    <div className="camera-toolbar">
      {busy ? <Button kind="tertiary" type="button" onClick={stop}>Dừng thu</Button>
        : <Button type="button" disabled={disabled} onClick={() => onStart(undefined, count === 5)}>
          {count === 5 ? 'Thu lại 5 góc' : count > 0 ? 'Tiếp tục thu' : 'Bắt đầu thu 5 góc'}
        </Button>}
      {count > 0 && count < 5 && !busy ? <Button kind="ghost" type="button" disabled={disabled} onClick={() => onStart(undefined, true)}>Thu lại từ đầu</Button> : null}
      <span className="capture-count" role="status" aria-live="polite">Đã kiểm tra {count}/5 góc</span>
    </div>
    {error ? <InlineNotification kind="error" role="alert" title="Chưa thu được ảnh" subtitle={error} hideCloseButton lowContrast /> : null}
    <div className="camera-frame enrollment-camera" style={{ aspectRatio: `${frameSize.width} / ${frameSize.height}` }}>
      <video ref={videoRef} muted playsInline aria-label="Camera đăng ký trực tiếp" className="mirrored-preview" />
      {!busy ? <div className="camera-placeholder"><div>
        <strong>{count === 5 ? 'Đã thu đủ ảnh khuôn mặt' : 'Tự thu ảnh theo hướng dẫn'}</strong>
        <p>{count === 5 ? 'Kiểm tra các góc bên dưới rồi lưu hồ sơ.' : 'Nhập tên, xác nhận đồng ý và bắt đầu. Không cần bấm chụp từng ảnh.'}</p>
      </div></div> : null}
      {busy ? <div className="enrollment-guide" aria-hidden="true"><span /></div> : null}
    </div>
    <div className="capture-instruction">
      <strong>{state === 'loading' ? 'Đang chuẩn bị…' : state === 'checking' ? `Đang kiểm tra · ${activePose.label}` : state === 'capturing' ? activePose.instruction : 'Ảnh chỉ có một người, mặt rõ và đủ sáng.'}</strong>
      <p role="status" className="capture-hint">{hint}</p>
      {state === 'capturing' ? <div className="capture-hold" role="progressbar" aria-label="Giữ ổn định đúng góc" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
        <span style={{ width: `${progress}%` }} />
      </div> : null}
    </div>
    <ol className="pose-grid" aria-label="Năm góc khuôn mặt">
      {POSES.map((pose, index) => {
        const photo = photos[pose.id]
        return <li key={pose.id} className={`pose-card${photo ? ' complete' : ''}${invalidIndex === index ? ' invalid' : ''}`}
          aria-current={state === 'capturing' && target === pose.id ? 'step' : undefined}>
          {photo ? <img src={photo.url} alt={`Góc ${pose.label} đã thu`} /> : <span className="pose-number" aria-hidden="true">{index + 1}</span>}
          <strong>{pose.label}</strong>
          <span>{invalidIndex === index ? 'Cần chụp lại' : photo ? 'Đã kiểm tra' : state === 'checking' && target === pose.id ? 'Đang kiểm tra…' : 'Chưa thu'}</span>
          {photo ? <Button kind="ghost" size="sm" type="button" disabled={disabled || busy} onClick={() => onStart(pose.id)} aria-label={`Chụp lại góc ${pose.label}`}>Chụp lại</Button> : null}
        </li>
      })}
    </ol>
    <p className="capture-note">Quay nhẹ theo hướng dẫn. Ảnh chưa đạt sẽ tự thu lại; hồ sơ chỉ được lưu khi bạn xác nhận.</p>
  </div>
}
