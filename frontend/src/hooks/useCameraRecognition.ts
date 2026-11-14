import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, getRequestStatus, recognizeFrame } from '../services/api'
import type { CameraState, RecognitionState, RecognizedFace, RecognitionResponse } from '../types/face'
import { configureCamera } from '../enrollment/camera'

const INTENT_KEY = 'attendly.pending-punch'
interface UseCameraRecognitionOptions {
  recognitionEnabled: boolean
  onAttendanceUpdated: (receipt: RecognitionResponse) => void
}

export function useCameraRecognition({ recognitionEnabled, onAttendanceUpdated }: UseCameraRecognitionOptions) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const activeRequestRef = useRef<AbortController | null>(null)
  const generationRef = useRef(0)
  const busyRef = useRef(false)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [initialIntent] = useState(() => sessionStorage.getItem(INTENT_KEY))
  const requestIdRef = useRef(initialIntent)
  const recoveryRef = useRef(!!initialIntent)
  const delayRef = useRef(250)
  const [cameraState, setCameraState] = useState<CameraState>('idle')
  const [recognitionState, setRecognitionState] = useState<RecognitionState>('idle')
  const [faces, setFaces] = useState<RecognizedFace[]>([])
  const [receipt, setReceipt] = useState<RecognitionResponse | null>(null)
  const [frameSize, setFrameSize] = useState({ width: 640, height: 480 })
  const [error, setError] = useState<string | null>(null)

  const releaseStream = useCallback(() => {
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  const stopCamera = useCallback(() => {
    generationRef.current += 1
    activeRequestRef.current?.abort()
    activeRequestRef.current = null
    releaseStream()
    // An aborted HTTP request may still commit on the server. Retain its UUID.
    recoveryRef.current = !!requestIdRef.current
    setFaces([])
    setReceipt(null)
    setError(null)
    setRecognitionState('idle')
    setCameraState('idle')
  }, [releaseStream])

  const acceptReceipt = useCallback((result: RecognitionResponse) => {
    if (result.status !== 'confirmed' || result.attendance.length === 0) return false
    releaseStream()
    sessionStorage.removeItem(INTENT_KEY)
    requestIdRef.current = null
    recoveryRef.current = false
    setReceipt(result)
    setFaces(result.faces)
    setCameraState('idle')
    setRecognitionState('recognized')
    setError(null)
    onAttendanceUpdated(result)
    return true
  }, [onAttendanceUpdated, releaseStream])

  const startCamera = useCallback(async () => {
    stopCamera()
    const generation = generationRef.current
    const controller = new AbortController()
    activeRequestRef.current = controller
    setCameraState('requesting')
    try {
      if (recognitionEnabled && requestIdRef.current) {
        const previous = await getRequestStatus(requestIdRef.current, controller.signal)
        if (generation !== generationRef.current) return
        if (previous.status === 'confirmed' && acceptReceipt(previous)) return
        if (previous.status === 'abandoned') {
          requestIdRef.current = null
          sessionStorage.removeItem(INTENT_KEY)
        }
        recoveryRef.current = false
      }
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera cần HTTPS hoặc địa chỉ localhost và trình duyệt hỗ trợ camera.')
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false,
      })
      if (generation !== generationRef.current) { stream.getTracks().forEach(track => track.stop()); return }
      streamRef.current = stream
      const track = stream.getVideoTracks()[0]
      if (track) await configureCamera(track, controller.signal)
      if (generation !== generationRef.current) return
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
        if (generation !== generationRef.current) return
        if (videoRef.current.videoWidth) setFrameSize({ width: videoRef.current.videoWidth, height: videoRef.current.videoHeight })
      }
      delayRef.current = 250
      setCameraState('active')
    } catch (error) {
      if (generation !== generationRef.current) return
      releaseStream()
      const denied = error instanceof DOMException && ['NotAllowedError', 'SecurityError'].includes(error.name)
      setCameraState(denied ? 'permission-denied' : 'unavailable')
      setError(denied ? 'Quyền camera bị từ chối. Cho phép truy cập trong cài đặt trình duyệt.' : error instanceof Error ? error.message : 'Không tìm thấy camera khả dụng.')
    } finally { if (activeRequestRef.current === controller) activeRequestRef.current = null }
  }, [acceptReceipt, recognitionEnabled, releaseStream, stopCamera])

  const captureAndRecognize = useCallback(async () => {
    const video = videoRef.current
    if (!recognitionEnabled || !video || !streamRef.current?.active || busyRef.current || video.readyState < 2 || !video.videoWidth) return
    const generation = generationRef.current
    const controller = new AbortController()
    busyRef.current = true
    activeRequestRef.current = controller
    setRecognitionState('recognizing')
    const started = performance.now()
    try {
      if (recoveryRef.current && requestIdRef.current) {
        const previous = await getRequestStatus(requestIdRef.current, controller.signal)
        if (generation !== generationRef.current) return
        if (previous.status === 'confirmed' && acceptReceipt(previous)) return
        if (previous.status === 'abandoned') throw new ApiError('Lượt trước đã hết hạn. Bấm dừng và bắt đầu lượt mới.', 409, 'request_expired')
        recoveryRef.current = false
      }
      const width = Math.min(video.videoWidth, 640)
      const height = Math.round(width * video.videoHeight / video.videoWidth)
      const canvas = canvasRef.current ?? (canvasRef.current = document.createElement('canvas'))
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Trình duyệt không thể xử lý ảnh camera.')
      context.drawImage(video, 0, 0, width, height)
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85))
      if (!blob) throw new Error('Không tạo được ảnh từ camera.')
      if (generation !== generationRef.current) return
      requestIdRef.current ??= crypto.randomUUID()
      sessionStorage.setItem(INTENT_KEY, requestIdRef.current)
      recoveryRef.current = true
      const result = await recognizeFrame(blob, requestIdRef.current, controller.signal)
      if (generation !== generationRef.current) return
      recoveryRef.current = false
      setFrameSize({ width, height })
      if (!acceptReceipt(result)) {
        setFaces(result.faces)
        setRecognitionState(result.faces.length ? 'unknown' : 'no-face')
        setError(null)
      }
      delayRef.current = Math.max(200, 500 - (performance.now() - started))
    } catch (error) {
      if (generation !== generationRef.current || controller.signal.aborted) return
      const api = error instanceof ApiError ? error : null
      setFaces([])
      setError(error instanceof Error ? error.message : 'Nhận diện không thành công.')
      setRecognitionState(api?.code === 'spoof_detected' ? 'spoof-detected' : 'backend-error')
      delayRef.current = api && [0, 429, 500, 502, 503, 504].includes(api.status) ? Math.min(5000, delayRef.current * 2 + 250) : 750
      if (api?.code === 'request_expired') {
        sessionStorage.removeItem(INTENT_KEY)
        requestIdRef.current = null
      }
      if (api && [401, 409].includes(api.status)) { releaseStream(); setCameraState('idle') }
    } finally {
      if (activeRequestRef.current === controller) activeRequestRef.current = null
      busyRef.current = false
    }
  }, [acceptReceipt, recognitionEnabled, releaseStream])

  useEffect(() => {
    const hidden = () => { if (document.hidden) stopCamera() }
    document.addEventListener('visibilitychange', hidden)
    return () => { document.removeEventListener('visibilitychange', hidden); stopCamera() }
  }, [stopCamera])

  useEffect(() => {
    if (cameraState !== 'active' || !recognitionEnabled) return
    let cancelled = false
    let timeout: number | undefined
    const loop = async () => {
      await captureAndRecognize()
      if (!cancelled && streamRef.current?.active) timeout = window.setTimeout(loop, delayRef.current)
    }
    // oxlint-disable-next-line react/set-state-in-effect
    void loop()
    return () => { cancelled = true; if (timeout !== undefined) window.clearTimeout(timeout) }
  }, [cameraState, captureAndRecognize, recognitionEnabled])

  return { videoRef, cameraState, recognitionState, faces, receipt, frameSize, error, startCamera, stopCamera }
}
