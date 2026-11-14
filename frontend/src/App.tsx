import { useState } from 'react'
import {
  Breadcrumb, BreadcrumbItem, Column, Content, Grid, Header,
  HeaderMenuButton, SideNav, SideNavItems, SideNavLink, SkipToContent, Button,
} from '@carbon/react'
import { AttendanceTab } from './components/AttendanceTab'
import { EnrollmentTab } from './components/EnrollmentTab'
import { SessionGate } from './components/SessionGate'
import type { EmployeeAttendance, Session } from './types/face'
import './App.css'

type ActiveTab = 'enrollment' | 'attendance'

function App() {
  return <SessionGate>{(session, logout) => <Workspace session={session} logout={logout} />}</SessionGate>
}

function Workspace({ session, logout }: { session: Session; logout: () => void }) {
  const [activeTab, setActiveTab] = useState<ActiveTab>('attendance')
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState<EmployeeAttendance | null>(null)
  const title = activeTab === 'attendance' ? 'Chấm công' : 'Đăng ký nhân viên'

  const navigate = (tab: ActiveTab) => {
    setActiveTab(tab)
    setMenuOpen(false)
    setEditing(null)
  }

  return (
    <div className="app-shell">
      <Header aria-label="Attendly" className="app-header">
        <SkipToContent href="#main-content">Đến nội dung chính</SkipToContent>
        <HeaderMenuButton
          aria-label={menuOpen ? 'Đóng menu' : 'Mở menu'}
          isActive={menuOpen}
          onClick={() => setMenuOpen(!menuOpen)}
        />
        <SideNav
          aria-label="Điều hướng chính"
          expanded={menuOpen}
          onToggle={() => setMenuOpen(false)}
          onOverlayClick={() => setMenuOpen(false)}
          onSideNavBlur={() => setMenuOpen(false)}
          className="app-sidebar"
        >
          <div className="sidebar-heading">
            <img className="brand-logo" src="/logo.jpg" alt="Logo chấm công" />
            <span>KHÔNG GIAN LÀM VIỆC</span>
          </div>
          <SideNavItems>
            <SideNavLink as="button" type="button" tabIndex={0} aria-current={activeTab === 'attendance' ? 'page' : undefined} isActive={activeTab === 'attendance'} onClick={() => navigate('attendance')}>
              Chấm công
            </SideNavLink>
            {session.role === 'admin' ? <SideNavLink as="button" type="button" tabIndex={0} aria-current={activeTab === 'enrollment' ? 'page' : undefined} isActive={activeTab === 'enrollment'} onClick={() => navigate('enrollment')}>
              Đăng ký nhân viên
            </SideNavLink> : null}
          </SideNavItems>
          <div className="sidebar-note"><strong>Nhận diện khuôn mặt</strong><p>Đăng ký một lần, chấm công mỗi ngày.</p><span>Múi giờ Việt Nam · UTC+7</span>
            {session.authentication_required ? <Button kind="ghost" onClick={logout}>Khóa phiên truy cập</Button> : null}
          </div>
        </SideNav>
      </Header>

      <Content id="main-content" className="main-content" tabIndex={-1}>
        <Grid fullWidth className="page-grid">
          <Column sm={4} md={8} lg={16}>
            <Breadcrumb noTrailingSlash aria-label="Đường dẫn">
              <BreadcrumbItem>Không gian làm việc</BreadcrumbItem>
              <BreadcrumbItem isCurrentPage>{title}</BreadcrumbItem>
            </Breadcrumb>
            <section className="intro" aria-labelledby="page-title">
              <div>
                <h1 id="page-title">{title}</h1>
                <p className="intro-copy">{activeTab === 'attendance'
                  ? 'Ghi nhận giờ vào, giờ ra và theo dõi nhân viên trong ngày.'
                  : 'Thêm hồ sơ khuôn mặt để nhân viên bắt đầu chấm công.'}</p>
              </div>
              <span className="page-label">Attendly / Nhân sự</span>
            </section>
            <div className="workspace">
              {activeTab === 'enrollment' ? (
                <EnrollmentTab employee={editing} onEnrolled={() => navigate('attendance')} />
              ) : (
                <AttendanceTab onReenroll={session.role === 'admin' ? employee => { setEditing(employee); setActiveTab('enrollment') } : undefined} />
              )}
            </div>
            <footer className="app-footer">
              <span>Xác minh khuôn mặt thật trước khi ghi công.</span>
              <span>Giờ chấm công được ghi từ máy chủ.</span>
            </footer>
          </Column>
        </Grid>
      </Content>
    </div>
  )
}

export default App
