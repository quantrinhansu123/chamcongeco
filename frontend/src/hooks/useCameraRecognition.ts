import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, recognizeFrame } from '../services/api'
import type {
  CameraState,
  RecognitionState,
  RecognizedFace,
} from '../types/face'

interface FrameSize {
  width: number
  height: number
}

interface UseCameraRecognitionOptions {
  action: 'in' | 'out'
  recognitionEnabled: boolean
  onAttendanceUpdated: () => void
}

export function useCameraRecognition({
  action,
  recognitionEnabled,
  onAttendanceUpdated,
}: UseCameraRecognitionOptions) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const activeRequestRef = useRef<AbortController | null>(null)
  const requestGenerationRef = useRef(0)
  const busyRef = useRef(false)
  const actionRef = useRef(action)
  const [cameraState, setCameraState] = useState<CameraState>('idle')
  const [recognitionState, setRecognitionState] = useState<RecognitionState>('idle')
  const [faces, setFaces] = useState<RecognizedFace[]>([])
  const [frameSize, setFrameSize] = useState<FrameSize>({ width: 640, height: 480 })
  const [error, setError] = useState<string | null>(null)

  const stopCamera = useCallback(() => {
    requestGenerationRef.current += 1
    activeRequestRef.current?.abort()
    activeRequestRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
    setFaces([])
    setError(null)
    setRecognitionState('idle')
    setCameraState('idle')
  }, [])

  const changeAction = useCallback((nextAction: 'in' | 'out') => {
    actionRef.current = nextAction
    requestGenerationRef.current += 1
    activeRequestRef.current?.abort()
    setFaces([])
    setError(null)
    setRecognitionState('idle')
  }, [])

  const startCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraState('unavailable')
      setError('Trình duyệt này không hỗ trợ truy cập camera.')
      return
    }

    stopCamera()
    const generation = requestGenerationRef.current
    setCameraState('requesting')
    setError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } },
        audio: false,
      })
      if (generation !== requestGenerationRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream
      if (videoRef.current) {
        videoRef.current.srcObject = stream
        await videoRef.current.play()
        if (generation !== requestGenerationRef.current) return
        if (videoRef.current.videoWidth > 0 && videoRef.current.videoHeight > 0) {
          setFrameSize({
            width: videoRef.current.videoWidth,
            height: videoRef.current.videoHeight,
          })
        }
      }
      setCameraState('active')
    } catch (cameraError) {
      if (generation !== requestGenerationRef.current) return
      streamRef.current?.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      if (videoRef.current) videoRef.current.srcObject = null
      const denied =
        cameraError instanceof DOMException &&
        ['NotAllowedError', 'SecurityError'].includes(cameraError.name)
      setCameraState(denied ? 'permission-denied' : 'unavailable')
      setError(
        denied
          ? 'Quyền camera bị từ chối. Cho phép truy cập trong cài đặt trình duyệt.'
          : 'Không tìm thấy camera khả dụng trên thiết bị.',
      )
    }
  }, [stopCamera])

  const captureAndRecognize = useCallback(async () => {
    const video = videoRef.current
    if (
      !recognitionEnabled ||
      !video ||
      !streamRef.current?.active ||
      busyRef.current
    ) {
      return
    }

    if (
      video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
      video.videoWidth === 0 ||
      video.videoHeight === 0
    ) {
      console.debug('[recognition] Waiting for a camera frame', {
        readyState: video.readyState,
        videoWidth: video.videoWidth,
        videoHeight: video.videoHeight,
      })
      return
    }

    const generation = requestGenerationRef.current
    const requestAction = actionRef.current
    busyRef.current = true
    setRecognitionState('recognizing')
    try {
      const width = Math.min(video.videoWidth, 640)
      const height = Math.round((width / video.videoWidth) * video.videoHeight)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d')
      if (!context) throw new Error('Trình duyệt không thể xử lý ảnh camera.')

      context.drawImage(video, 0, 0, width, height)
      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', 0.82),
      )
      if (!blob) throw new Error('Trình duyệt không thể tạo ảnh từ camera.')
      if (generation !== requestGenerationRef.current) return

      const controller = new AbortController()
      activeRequestRef.current = controller
      console.info('[recognition] Sending camera frame', {
        width,
        height,
        bytes: blob.size,
      })
      const result = await recognizeFrame(blob, controller.signal, requestAction)
      if (generation !== requestGenerationRef.current) return
      console.info('[recognition] Result received', {
        faces: result.faces.length,
        matched: result.faces.filter((face) => face.employee_id !== null).length,
        attendanceUpdated: result.attendance_updated,
      })
      setFaces(result.faces)
      setFrameSize({ width, height })
      if (result.faces.some((face) => face.employee_id !== null)) {
        // One confirmed recognition per click; checkout requires a new user action.
        streamRef.current?.getTracks().forEach((track) => track.stop())
        streamRef.current = null
        if (videoRef.current) videoRef.current.srcObject = null
        setCameraState('idle')
        setRecognitionState('recognized')
        onAttendanceUpdated()
      } else if (result.faces.length > 0) {
        setRecognitionState('unknown')
      } else {
        setRecognitionState('no-face')
      }
      setError(null)
    } catch (requestError) {
      if (generation !== requestGenerationRef.current) return
      if (requestError instanceof DOMException && requestError.name === 'AbortError') return
      console.error('[recognition] Camera frame failed', requestError)
      const message = requestError instanceof Error ? requestError.message : 'Nhận diện không thành công.'
      if (
        requestError instanceof ApiError &&
        requestError.status === 403 &&
        /photo or screen replay/i.test(message)
      ) {
        setFaces([])
        setRecognitionState('spoof-detected')
        setError('Phát hiện ảnh hoặc màn hình. Hãy dùng khuôn mặt thật; chưa ghi nhận chấm công.')
      } else {
        setRecognitionState('backend-error')
        setError(message)
      }
    } finally {
      activeRequestRef.current = null
      busyRef.current = false
    }
  }, [onAttendanceUpdated, recognitionEnabled])

  useEffect(() => {
    return stopCamera
  }, [stopCamera])

  useEffect(() => {
    if (cameraState !== 'active' || !recognitionEnabled) return

    let cancelled = false
    let timeout: number | undefined

    const recognizeContinuously = async () => {
      await captureAndRecognize()
      if (!cancelled) timeout = window.setTimeout(recognizeContinuously, 1000)
    }

    // Frame recognition synchronizes the live camera with the backend.
    // oxlint-disable-next-line react/set-state-in-effect
    void recognizeContinuously()
    return () => {
      cancelled = true
      if (timeout !== undefined) window.clearTimeout(timeout)
    }
  }, [cameraState, captureAndRecognize, recognitionEnabled])

  return {
    videoRef,
    cameraState,
    recognitionState,
    faces,
    frameSize,
    error,
    startCamera,
    stopCamera,
    changeAction,
  }
}
