import { useCallback, useEffect, useState } from 'react'
import { getEmployees } from '../services/api'
import type { EmployeeAttendance } from '../types/face'
import { useCameraRecognition } from '../hooks/useCameraRecognition'
import { CameraView } from './CameraView'
import { EmployeeList } from './EmployeeList'

function formatAttendanceTime(value: string): string {
  return new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(new Date(value))
}

export function AttendanceTab() {
  const [action, setAction] = useState<'in' | 'out'>('in')
  const [employees, setEmployees] = useState<EmployeeAttendance[]>([])
  const [loading, setLoading] = useState(true)
  const [listError, setListError] = useState<string | null>(null)

  const refreshEmployees = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await getEmployees(signal)
      setEmployees(result)
      setListError(null)
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return
      setListError(error instanceof Error ? error.message : 'Không thể tải danh sách nhân viên.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    // Loading from the API is the external synchronization owned by this effect.
    // oxlint-disable-next-line react/set-state-in-effect
    void refreshEmployees(controller.signal)
    const interval = window.setInterval(() => void refreshEmployees(), 5000)
    return () => {
      controller.abort()
      window.clearInterval(interval)
    }
  }, [refreshEmployees])

  const camera = useCameraRecognition({
    action,
    recognitionEnabled: employees.length > 0 && !listError,
    onAttendanceUpdated: refreshEmployees,
  })
  const recognizedEmployees = new Map<string, string>()
  for (const face of camera.faces) {
    if (face.employee_id) recognizedEmployees.set(face.employee_id, face.name)
  }
  const showAttendanceResults =
    !listError &&
    camera.recognitionState !== 'backend-error' &&
    camera.recognitionState !== 'spoof-detected' &&
    recognizedEmployees.size > 0
  const matchedEmployees = [...recognizedEmployees.keys()].map((id) =>
    employees.find((employee) => employee.employee_id === id),
  )
  const hasResult = camera.recognitionState === 'recognized' && matchedEmployees.length > 0
  const hasArrival = hasResult && matchedEmployees.every((employee) => employee?.arrived_at)
  const isComplete = hasResult && matchedEmployees.every((employee) => employee?.departed_at)
  const nextAction = hasArrival ? 'out' : action
  const awaitingConfirmation = hasResult && matchedEmployees.some((employee) =>
    action === 'out' ? !employee?.departed_at : !employee?.arrived_at,
  )

  const startAttendance = () => {
    camera.changeAction(nextAction)
    setAction(nextAction)
    void camera.startCamera()
  }

  return (
    <section className="panel" aria-labelledby="attendance-title">
      <div className="panel-header">
        <div>
          <h2 id="attendance-title">Chấm công khuôn mặt</h2>
          <p>Chấm công vào khi bắt đầu ca. Sau khi ghi nhận, dùng cùng nút để chấm công ra.</p>
        </div>
        <span className="step-pill">Giờ Việt Nam · UTC+7</span>
      </div>

      <div className="camera-layout">
        <div className="attendance-workspace">
          <CameraView
            videoRef={camera.videoRef}
            cameraState={camera.cameraState}
            recognitionState={camera.recognitionState}
            faces={camera.faces}
            frameSize={camera.frameSize}
            error={camera.error}
            hasEmployees={employees.length > 0}
            actionLabel={isComplete ? 'Đã chấm công hôm nay' : nextAction === 'out' ? 'Chấm công ra' : 'Chấm công vào'}
            actionDisabled={loading || !!listError || employees.length === 0 || awaitingConfirmation || isComplete}
            hasResult={hasResult}
            onStart={startAttendance}
            onStop={() => { camera.stopCamera(); camera.changeAction('in'); setAction('in') }}
          />
          {showAttendanceResults ? (
            <div className="attendance-confirmations" aria-live="polite">
              {[...recognizedEmployees].map(([employeeId, name]) => {
                const employee = employees.find((item) => item.employee_id === employeeId)
                const arrivedAt = action === 'out' ? employee?.departed_at : employee?.arrived_at

                return (
                  <div className={`attendance-confirmation${arrivedAt ? '' : ' pending'}`} key={employeeId}>
                    {arrivedAt ? <span className="attendance-confirmation-check" aria-hidden="true">
                      <svg viewBox="0 0 24 24">
                        <path d="m6.5 12.5 3.5 3.5 7.5-8" />
                      </svg>
                    </span> : <span className="spinner" aria-hidden="true" />}
                    <div className="attendance-confirmation-copy">
                      <strong>{name}</strong>
                      <span>
                        {arrivedAt
                          ? `${action === 'out' ? 'Đã ghi giờ ra' : 'Đã ghi giờ vào'}: ${formatAttendanceTime(arrivedAt)}`
                          : 'Đang cập nhật giờ chấm công…'}
                      </span>
                    </div>
                    <span className="attendance-confirmation-badge">
                      {arrivedAt ? 'Đã lưu' : 'Đang lưu'}
                    </span>
                  </div>
                )
              })}
            </div>
          ) : null}
        </div>
        <EmployeeList employees={employees} loading={loading} error={listError} />
      </div>
    </section>
  )
}
