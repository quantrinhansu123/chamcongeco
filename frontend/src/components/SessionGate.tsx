import { useEffect, useRef, useState } from 'react'
import { Button, InlineLoading, InlineNotification, PasswordInput } from '@carbon/react'
import { ApiError, getAccessKey, getSession, setAccessKey } from '../services/api'
import type { Session } from '../types/face'

export function SessionGate({ children }: { children: (session: Session, logout: () => void) => React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [checking, setChecking] = useState(true)
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const controllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    getSession(controller.signal).then(setSession).catch(error => {
      if (error instanceof DOMException && error.name === 'AbortError') return
      if (!(error instanceof ApiError && error.status === 401)) setError(error.message)
    }).finally(() => { if (!controller.signal.aborted) setChecking(false) })
    const expired = () => { setSession(null); setError('Phiên truy cập đã hết hiệu lực. Nhập lại mã truy cập.') }
    window.addEventListener('attendly:authentication-required', expired)
    return () => { controller.abort(); controllerRef.current?.abort(); window.removeEventListener('attendly:authentication-required', expired) }
  }, [])

  const login = async (event: React.FormEvent) => {
    event.preventDefault()
    if (checking) return
    setChecking(true)
    setError(null)
    const previous = getAccessKey()
    setAccessKey(key.trim())
    const controller = new AbortController()
    controllerRef.current = controller
    try { setSession(await getSession(controller.signal)); setKey('') }
    catch (error) {
      setAccessKey(previous)
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : 'Chưa thể truy cập.')
    } finally { if (!controller.signal.aborted) setChecking(false) }
  }

  if (session) return children(session, () => { setAccessKey(''); setSession(null) })
  return <main className="session-gate">
    <form onSubmit={event => void login(event)}>
      <h1>Truy cập trạm chấm công</h1>
      <p>Nhập mã trạm hoặc mã quản trị do người vận hành cung cấp.</p>
      <PasswordInput id="access-key" labelText="Mã truy cập" value={key} autoComplete="off" disabled={checking}
        onChange={event => setKey(event.target.value)} hidePasswordLabel="Ẩn mã truy cập" showPasswordLabel="Hiện mã truy cập" />
      {error ? <InlineNotification kind="error" title="Chưa thể truy cập" subtitle={error} hideCloseButton lowContrast /> : null}
      <Button type="submit" disabled={checking}>{checking ? 'Đang kết nối…' : 'Tiếp tục'}</Button>
      {checking ? <InlineLoading description="Đang kiểm tra kết nối" /> : null}
    </form>
  </main>
}
