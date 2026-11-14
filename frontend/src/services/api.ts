import type { EmployeeAttendance, EmployeeCreated, RecognitionResponse, RequestStatus, Session } from '../types/face'
import type { EnrollmentValidation, PoseId, QualityPolicy } from '../enrollment/types'

const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '')
const KEY = 'attendly.access-key'
export const getAccessKey = () => sessionStorage.getItem(KEY) ?? ''
export const setAccessKey = (key: string) => key ? sessionStorage.setItem(KEY, key) : sessionStorage.removeItem(KEY)

export class ApiError extends Error {
  status: number
  code: string
  imageIndex: number | null
  constructor(message: string, status: number, code = '', imageIndex: number | null = null) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.imageIndex = imageIndex
  }
}

async function request<T>(path: string, options: RequestInit = {}, timeoutMs = 15_000): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
  const headers = new Headers(options.headers)
  const key = getAccessKey()
  if (key) headers.set('Authorization', `Bearer ${key}`)
  let response: Response
  try {
    response = await fetch(`${API_URL}${path}`, { ...options, headers, signal, cache: 'no-store' })
  } catch {
    if (options.signal?.aborted) throw new DOMException('Đã hủy yêu cầu.', 'AbortError')
    throw new ApiError(timeout.aborted
      ? 'Máy chủ phản hồi chậm. Kiểm tra kết nối rồi thử lại.'
      : 'Không kết nối được máy chủ chấm công. Kiểm tra kết nối.', 0, timeout.aborted ? 'timeout' : 'network')
  }
  if (!response.ok) {
    let message = `Yêu cầu thất bại (mã ${response.status}).`
    let code = ''
    let imageIndex: number | null = null
    try {
      const body = await response.json() as { detail?: unknown; code?: string; image_index?: number }
      if (typeof body.detail === 'string') message = body.detail
      code = body.code ?? ''
      if (Number.isInteger(body.image_index) && body.image_index! >= 0 && body.image_index! < 5) imageIndex = body.image_index!
    } catch { /* Keep the HTTP fallback for non-JSON proxy errors. */ }
    if (response.status === 401 && path !== '/api/session') window.dispatchEvent(new Event('attendly:authentication-required'))
    throw new ApiError(message, response.status, code, imageIndex)
  }
  return response.json() as Promise<T>
}

export const getSession = (signal?: AbortSignal) => request<Session>('/api/session', { signal })
export const getEnrollmentPolicy = (signal?: AbortSignal) => request<QualityPolicy>('/api/enrollment/policy', { signal })
export const getEmployees = (signal?: AbortSignal) => request<EmployeeAttendance[]>('/api/employees', { signal })
export const getRequestStatus = (id: string, signal?: AbortSignal) => request<RequestStatus>(`/api/recognition-requests/${encodeURIComponent(id)}`, { signal })

export function validateEnrollmentPhoto(image: File, pose: PoseId, signal: AbortSignal, reference?: File) {
  const body = new FormData()
  body.append('consent', 'true')
  body.append('pose', pose)
  body.append('image', image)
  if (reference) body.append('reference', reference)
  return request<EnrollmentValidation>('/api/enrollment/validate', { method: 'POST', body, signal }, 10_000)
}

export function enrollEmployee(name: string, images: File[], employeeId?: string, signal?: AbortSignal, poses?: readonly string[]): Promise<EmployeeCreated> {
  const body = new FormData()
  body.append('name', name)
  body.append('consent', 'true')
  body.append('capture_mode', poses ? 'guided' : 'upload')
  if (poses) body.append('pose_labels', JSON.stringify(poses))
  images.forEach(image => body.append('image', image))
  return request<EmployeeCreated>(employeeId ? `/api/employees/${encodeURIComponent(employeeId)}/face` : '/api/employees', {
    method: employeeId ? 'PUT' : 'POST', body, signal,
  }, 60_000)
}

export function recognizeFrame(image: Blob, requestId: string, signal?: AbortSignal): Promise<RecognitionResponse> {
  const body = new FormData()
  body.append('image', image, 'camera-frame.jpg')
  body.append('request_id', requestId)
  body.append('action', 'auto')
  return request<RecognitionResponse>('/api/recognize', { method: 'POST', body, signal })
}
