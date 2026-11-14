import { useCallback, useEffect, useRef, useState } from 'react'
import { CaptureGate } from '../enrollment/pose'
import { POSES } from '../enrollment/types'
import type { CapturedPhoto, Orientation, PoseId } from '../enrollment/types'
import { VisionTracker } from '../enrollment/tracker'
import { configureCamera } from '../enrollment/camera'
import { validatePolicy } from '../enrollment/quality'
import { ApiError, getEnrollmentPolicy, validateEnrollmentPhoto } from '../services/api'

type State = 'idle' | 'loading' | 'capturing' | 'checking' | 'paused' | 'review' | 'error'
const retryableQuality = new Set(['face_blurry', 'face_dark', 'face_bright', 'face_too_small', 'face_count', 'face_alignment', 'different_faces'])
const abortError = () => new DOMException('Đã hủy.', 'AbortError')
const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) { reject(abortError()); return }
  const onAbort = () => { clearTimeout(timer); reject(abortError()) }
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve() }, ms)
  signal.addEventListener('abort', onAbort, { once: true })
})
const jpeg = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Không tạo được ảnh camera.')), 'image/jpeg', .9))

export function useAutoEnrollment() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const resources = useRef<{ stream?: MediaStream; tracker?: VisionTracker; controller?: AbortController }>({})
  const generation = useRef(0)
  const photosRef = useRef<Partial<Record<PoseId, CapturedPhoto>>>({})
  const [photos, setPhotos] = useState<Partial<Record<PoseId, CapturedPhoto>>>({})
  const [state, setState] = useState<State>('idle')
  const [target, setTarget] = useState<PoseId>('front')
  const [progress, setProgress] = useState(0)
  const [hint, setHint] = useState('Bắt đầu để tự thu đủ 5 góc khuôn mặt.')
  const [error, setError] = useState<string | null>(null)
  const [frameSize, setFrameSize] = useState({ width: 640, height: 480 })

  const releasePhotos = useCallback(() => {
    Object.values(photosRef.current).forEach(photo => URL.revokeObjectURL(photo.url))
    photosRef.current = {}
  }, [])

  const dispose = useCallback(() => {
    resources.current.controller?.abort()
    resources.current.tracker?.close()
    resources.current.stream?.getTracks().forEach(track => track.stop())
    resources.current = {}
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  const stop = useCallback(() => {
    generation.current++
    dispose()
    setState(POSES.every(pose => photosRef.current[pose.id]) ? 'review' : Object.keys(photosRef.current).length ? 'paused' : 'idle')
    setProgress(0)
    setHint('Đã dừng camera. Có thể tiếp tục thu các góc còn thiếu.')
  }, [dispose])

  const clear = useCallback(() => {
    generation.current++
    dispose()
    releasePhotos()
    setPhotos({}); setState('idle'); setTarget('front'); setProgress(0); setError(null)
    setHint('Bắt đầu để tự thu đủ 5 góc khuôn mặt.')
  }, [dispose, releasePhotos])

  const start = useCallback(async (retake?: PoseId, restart = false) => {
    generation.current++
    const token = generation.current
    dispose()
    if (restart) {
      releasePhotos(); setPhotos({})
    }
    const goals = retake ? [retake] : POSES.map(pose => pose.id).filter(id => !photosRef.current[id])
    if (!goals.length) { setState('review'); return }
    setState('loading'); setError(null); setProgress(0)
    setHint('Đang chuẩn bị camera và bộ hướng dẫn. Lần đầu có thể cần chờ tải.')
    const controller = new AbortController()
    resources.current.controller = controller
    const active = () => token === generation.current && !controller.signal.aborted
    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.Worker || !window.createImageBitmap || !window.OffscreenCanvas) throw new Error('Thiết bị chưa hỗ trợ tự thu khuôn mặt. Dùng trình duyệt mới qua HTTPS/localhost hoặc chọn Tải ảnh lên.')
      const tracker = new VisionTracker()
      resources.current.tracker = tracker
      const camera = navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false }).then(async stream => {
        if (!active()) { stream.getTracks().forEach(track => track.stop()); throw abortError() }
        resources.current.stream = stream
        const track = stream.getVideoTracks()[0]
        if (track) await configureCamera(track, controller.signal)
        if (!active()) throw abortError()
        if (!videoRef.current) throw abortError()
        videoRef.current.srcObject = stream
        await videoRef.current.play()
      })
      const initialize = async () => {
        const policy = await getEnrollmentPolicy(controller.signal)
        validatePolicy(policy)
        if (!active()) throw abortError()
        await tracker.initialize(policy)
      }
      await Promise.all([camera, initialize()])
      if (!active()) return
      const video = videoRef.current
      if (!video) throw abortError()
      const width = Math.min(video.videoWidth, 1280)
      const height = Math.round(width * video.videoHeight / video.videoWidth)
      if (!width || !height) throw new Error('Camera chưa gửi được hình ảnh. Hãy thử lại.')
      setFrameSize({ width, height }); setState('capturing')
      const canvas = document.createElement('canvas')
      canvas.width = width; canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Trình duyệt không xử lý được ảnh camera.')
      setHint('Giữ khuôn mặt trong khung, chờ camera ổn định ánh sáng…')
      await delay(800, controller.signal)
      for (const pose of goals) {
        if (!active()) return
        setTarget(pose); setProgress(0)
        const gateForPose = () => new CaptureGate(pose, pose === 'front' ? undefined : photosRef.current.front?.orientation)
        let gate = gateForPose()
        let best: { canvas: HTMLCanvasElement; orientation: Orientation } | null = null
        let qualityAttempts = 0
        let lastFrame = -1, lastNewFrame = performance.now()
        const deadline = performance.now() + 60_000
        while (active()) {
          const started = performance.now()
          if (started > deadline) throw new Error('Chưa thu được góc này. Giữ các ảnh đã có, bấm Tiếp tục thu hoặc chụp lại góc cần thiết.')
          if (video.currentTime === lastFrame || video.readyState < 2) {
            if (started - lastNewFrame > 5000) throw new Error('Camera không gửi hình ảnh mới. Kiểm tra camera rồi thử lại.')
            await delay(80, controller.signal); continue
          }
          lastFrame = video.currentTime; lastNewFrame = started
          context.drawImage(video, 0, 0, width, height)
          const smallWidth = Math.min(640, width)
          const bitmap = await createImageBitmap(canvas, { resizeWidth: smallWidth, resizeHeight: Math.round(smallWidth * height / width) })
          if (!active()) { bitmap.close(); return }
          const frame = await tracker.analyze(bitmap, performance.now())
          if (!active()) return
          const decision = gate.update(frame, performance.now())
          setHint(decision.hint); setProgress(decision.progress)
          if (decision.reset) best = null
          if (decision.replaceBest && frame.orientation) {
            const chosen = document.createElement('canvas')
            chosen.width = width; chosen.height = height
            chosen.getContext('2d')?.drawImage(canvas, 0, 0)
            best = { canvas: chosen, orientation: frame.orientation }
          }
          if (decision.capture && best) {
            const blob = await jpeg(best.canvas)
            if (!active()) return
            const file = new File([blob], `${pose}.jpg`, { type: 'image/jpeg' })
            setState('checking'); setHint('Đang kiểm tra chất lượng và đối chiếu khuôn mặt trên máy chủ…')
            qualityAttempts++
            try {
              // Only selected photos go to the server, never the live video.
              // Retaking front also compares to the old front so other slots
              // cannot silently become samples from a different employee.
              const reference = photosRef.current.front?.file
              let accepted = false
              for (let retry = 0; retry <= 2; retry++) {
                if (!active()) return
                if (performance.now() > deadline) throw new Error('Kiểm tra ảnh mất quá lâu. Kiểm tra kết nối rồi tiếp tục thu.')
                try {
                  const result = await validateEnrollmentPhoto(file, pose, controller.signal, reference)
                  if (!result.valid || result.pose !== pose || !!reference !== result.reference_checked) throw new Error('Máy chủ chưa xác nhận ảnh. Tải lại trang rồi thử lại.')
                  accepted = true
                  break
                } catch (error) {
                  const temporary = error instanceof ApiError && [0, 429, 502, 503, 504].includes(error.status)
                  if (!temporary || retry === 2) throw error
                  setHint('Máy chủ phản hồi chậm hoặc đang bận. Đang tự thử lại…')
                  await delay(1000 * (retry + 1), controller.signal)
                }
              }
              if (!active() || !accepted) return
            } catch (error) {
              if (!active()) return
              if (error instanceof ApiError && retryableQuality.has(error.code) && qualityAttempts < 8 && performance.now() < deadline) {
                setState('capturing'); setProgress(0)
                setHint(`${error.message} Đang tự chọn lại ảnh…`)
                best = null; gate = gateForPose()
                await delay(1000, controller.signal)
                continue
              }
              throw error
            }
            const old = photosRef.current[pose]
            if (old) URL.revokeObjectURL(old.url)
            photosRef.current = { ...photosRef.current, [pose]: { pose, file, url: URL.createObjectURL(file), orientation: best.orientation } }
            setPhotos({ ...photosRef.current }); setProgress(100); setState('capturing')
            break
          }
          await delay(Math.max(50, 110 - (performance.now() - started)), controller.signal)
        }
      }
      if (active()) {
        dispose(); setState(POSES.every(pose => photosRef.current[pose.id]) ? 'review' : 'paused')
        setHint('Máy chủ đã kiểm tra các ảnh đã thu. Xem lại các góc bên dưới rồi lưu hồ sơ.')
      }
    } catch (error) {
      if (!active()) return
      const denied = error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)
      const message = denied ? 'Quyền camera bị từ chối. Cho phép camera trong cài đặt trình duyệt hoặc chọn Tải ảnh lên.' : error instanceof Error ? error.message : 'Chưa thu được ảnh. Hãy thử lại.'
      dispose(); setError(message); setState('error'); setProgress(0)
    }
  }, [dispose, releasePhotos])

  const teardown = useCallback(() => { generation.current++; dispose(); releasePhotos() }, [dispose, releasePhotos])

  useEffect(() => {
    const hidden = () => { if (document.hidden) stop() }
    document.addEventListener('visibilitychange', hidden)
    return () => {
      document.removeEventListener('visibilitychange', hidden)
      teardown()
    }
  }, [stop, teardown])

  return { videoRef, photos, state, target, progress, hint, error, frameSize, start, stop, clear }
}
