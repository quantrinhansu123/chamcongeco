import { useCallback, useEffect, useRef, useState } from 'react'
import { getEmployees } from '../services/api'
import type { EmployeeAttendance, RecognitionResponse } from '../types/face'
import { useCameraRecognition } from '../hooks/useCameraRecognition'
import { CameraView } from './CameraView'
import { EmployeeList } from './EmployeeList'

const formatTime = (value: string) => new Intl.DateTimeFormat('vi-VN', {
  hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Ho_Chi_Minh',
}).format(new Date(value))

export function AttendanceTab({ onReenroll }: { onReenroll?: (employee: EmployeeAttendance) => void }) {
  const [employees, setEmployees] = useState<EmployeeAttendance[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)
  const listControllerRef = useRef<AbortController | null>(null)
  const listGenerationRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    let timeout: number | undefined
    const refresh = async () => {
      const controller = new AbortController()
      listControllerRef.current = controller
      const generation = listGenerationRef.current
      try {
        if (!document.hidden) {
          const result = await getEmployees(controller.signal)
          if (!cancelled && generation === listGenerationRef.current) { setEmployees(result); setListError(null) }
        }
      } catch (error) {
        if (!cancelled && !controller.signal.aborted) setListError(error instanceof Error ? error.message : 'Không thể tải danh sách nhân viên.')
      } finally {
        if (!cancelled) { setLoading(false); timeout = window.setTimeout(refresh, 10_000) }
      }
    }
    void refresh()
    return () => { cancelled = true; listControllerRef.current?.abort(); if (timeout !== undefined) window.clearTimeout(timeout) }
  }, [])

  const applyReceipt = useCallback((receipt: RecognitionResponse) => {
    listGenerationRef.current += 1
    listControllerRef.current?.abort()
    setEmployees(previous => previous.map(employee => receipt.attendance.find(row => row.employee_id === employee.employee_id) ?? employee))
  }, [])
  const compatible = employees.some(employee => !employee.requires_reenrollment)
  const camera = useCameraRecognition({ recognitionEnabled: compatible, onAttendanceUpdated: applyReceipt })
  const receipt = camera.receipt
  const complete = !!receipt?.attendance.every(employee => employee.departed_at)

  return <section className="panel" aria-labelledby="attendance-title">
    <div className="panel-header">
      <div><h2 id="attendance-title">Chấm công khuôn mặt</h2><p>Tự động ghi giờ vào hoặc giờ ra theo lượt chấm công đã lưu hôm nay.</p></div>
      <span className="step-pill">Giờ Việt Nam · UTC+7</span>
    </div>
    <div className="camera-layout">
      <div className="attendance-workspace">
        <CameraView videoRef={camera.videoRef} cameraState={camera.cameraState} recognitionState={camera.recognitionState}
          faces={camera.faces} frameSize={camera.frameSize} error={camera.error} hasEmployees={compatible}
          actionLabel="Chấm công" actionDisabled={loading || !compatible || complete} hasResult={!!receipt}
          onStart={() => void camera.startCamera()} onStop={camera.stopCamera} />
        {receipt ? <div className="attendance-confirmations" aria-live="polite">
          {receipt.attendance.map(employee => {
            const at = receipt.action === 'out' ? employee.departed_at : employee.arrived_at
            return <div className="attendance-confirmation" key={employee.employee_id}>
              <span className="attendance-confirmation-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m6.5 12.5 3.5 3.5 7.5-8" /></svg></span>
              <div className="attendance-confirmation-copy"><strong>{employee.name}</strong>
                <span>{at ? `${receipt.action === 'out' ? 'Đã ghi giờ ra' : 'Đã ghi giờ vào'}: ${formatTime(at)}` : 'Chưa có giờ chấm công'}</span>
                {receipt.replayed ? <small>Giữ nguyên thời gian đã lưu của lượt chấm công.</small> : null}
              </div>
              <span className="attendance-confirmation-badge">Đã lưu</span>
            </div>
          })}
        </div> : null}
      </div>
      <EmployeeList employees={employees} loading={loading} error={listError} onReenroll={onReenroll} />
    </div>
  </section>
}
