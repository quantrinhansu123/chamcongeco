import type { FrameAssessment, QualityPolicy, WorkerReply } from './types'

export class VisionTracker {
  private worker = new Worker(new URL('./vision.worker.ts', import.meta.url), { type: 'module' })
  private nextId = 0
  private closed = false
  private pending = new Map<number, { resolve: (reply: WorkerReply) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<WorkerReply>) => {
      const request = this.pending.get(data.id)
      if (!request) return
      clearTimeout(request.timer)
      this.pending.delete(data.id)
      if (data.type === 'error') request.reject(new Error('Chưa xử lý được camera. Thử lại hoặc chọn Tải ảnh lên.'))
      else request.resolve(data)
    }
    this.worker.onerror = () => this.fail(new Error('Không tải được bộ hướng dẫn camera. Kiểm tra kết nối hoặc chọn Tải ảnh lên.'))
  }

  private fail(error: Error) {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error) }
    this.pending.clear()
  }

  private request(type: 'init' | 'frame', bitmap?: ImageBitmap, timestamp?: number, policy?: QualityPolicy): Promise<WorkerReply> {
    if (this.closed) { bitmap?.close(); return Promise.reject(new DOMException('Đã hủy.', 'AbortError')) }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(type === 'init' ? 'Tải bộ hướng dẫn camera quá lâu. Thử lại hoặc chọn Tải ảnh lên.' : 'Camera phản hồi chậm. Hãy bắt đầu lại.'))
      }, type === 'init' ? 45_000 : 8_000)
      this.pending.set(id, { resolve, reject, timer })
      try { this.worker.postMessage({ type, id, bitmap, timestamp, policy }, bitmap ? [bitmap] : []) }
      catch (error) { clearTimeout(timer); this.pending.delete(id); bitmap?.close(); reject(error) }
    })
  }

  async initialize(policy: QualityPolicy) { await this.request('init', undefined, undefined, policy) }
  async analyze(bitmap: ImageBitmap, timestamp: number): Promise<FrameAssessment> {
    const reply = await this.request('frame', bitmap, timestamp)
    if (reply.type !== 'frame') throw new Error('Không đọc được hướng khuôn mặt.')
    return reply.frame
  }
  close() { this.closed = true; this.fail(new DOMException('Đã hủy.', 'AbortError')); this.worker.terminate() }
}
