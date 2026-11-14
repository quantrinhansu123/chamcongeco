import { useState } from 'react'
import { Button, InlineNotification, TextInput } from '@carbon/react'
import type { EmployeeAttendance } from '../types/face'

interface EmployeeListProps {
  employees: EmployeeAttendance[]
  loading: boolean
  error: string | null
  onReenroll?: (employee: EmployeeAttendance) => void
}

function formatArrival(value: string | null): string {
  if (!value) return '—'
  return new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'Asia/Ho_Chi_Minh',
  }).format(new Date(value))
}

export function EmployeeList({ employees, loading, error, onReenroll }: EmployeeListProps) {
  const [query, setQuery] = useState('')
  const search = query.trim().toLocaleLowerCase('vi-VN')
  const filteredEmployees = employees.filter((employee) =>
    `${employee.name} ${employee.employee_id}`.toLocaleLowerCase('vi-VN').includes(search),
  )
  const arrivedCount = employees.filter((employee) => employee.is_arrive).length

  return (
    <aside className="employee-card" aria-labelledby="employees-heading">
      <div className="employee-card-header">
        <div>
          <h3 id="employees-heading">Nhân viên hôm nay</h3>
          <p>{loading ? 'Đang tải dữ liệu' : error ? 'Dữ liệu chưa được cập nhật' : `${arrivedCount} đã vào ca / ${employees.length} nhân viên`}</p>
        </div>
        <span className="count-badge" aria-label={`${employees.length} nhân viên`}>
          {employees.length}
        </span>
      </div>

      {loading && employees.length === 0 ? (
        <div className="empty-list">Đang tải nhân viên…</div>
      ) : null}
      {error ? <InlineNotification kind="error" role="alert" title="Chưa tải được danh sách" subtitle={error} hideCloseButton lowContrast /> : null}
      {!loading && !error && employees.length === 0 ? (
        <div className="empty-list">
          Chưa có nhân viên. Chọn Đăng ký nhân viên để thêm hồ sơ.
        </div>
      ) : null}

      {employees.length > 0 ? (
        <>
        <div className="employee-search">
          <TextInput id="employee-search" type="search" labelText="Tìm nhân viên"
            placeholder="Nhập tên hoặc mã nhân viên" value={query}
            onChange={(event) => setQuery(event.target.value)} />
        </div>
        {filteredEmployees.length === 0 ? <p className="empty-list" role="status">Không tìm thấy nhân viên phù hợp.</p> : null}
        <ul className="employee-list">
          {filteredEmployees.map((employee) => (
            <li className="employee-row" key={employee.employee_id}>
              <span className={`arrival-check${employee.is_arrive ? ' arrived' : ''}`}>
                {employee.is_arrive ? (
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m6.5 12.5 3.5 3.5 7.5-8" />
                  </svg>
                ) : null}
              </span>
              <span>
                <span className="employee-name">{employee.name}</span>
                <span className="employee-id">{employee.employee_id}</span>
                {employee.requires_reenrollment ? <span className="reenrollment-note">Cần cập nhật khuôn mặt</span> : null}
                {onReenroll ? <Button kind="ghost" size="sm" onClick={() => onReenroll(employee)} aria-label={`Cập nhật khuôn mặt ${employee.name}`}>Cập nhật ảnh</Button> : null}
              </span>
              <span className={`arrival-time${employee.is_arrive ? ' arrived' : ''}`}>
                <span><small>Vào ca</small><time dateTime={employee.arrived_at ?? undefined}>{formatArrival(employee.arrived_at)}</time></span>
                <span><small>Ra ca</small><time dateTime={employee.departed_at ?? undefined}>{formatArrival(employee.departed_at)}</time></span>
              </span>
            </li>
          ))}
        </ul>
        </>
      ) : null}
    </aside>
  )
}
