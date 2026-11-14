/// <reference lib="webworker" />
import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'
import { orientationFromMatrix } from './pose'
import { eyeAspectRatio, faceBounds, pixelQuality, qualityIssue, qualityScore, validatePolicy } from './quality'
import type { FrameAssessment, QualityPolicy, WorkerReply, WorkerRequest } from './types'

const worker = self as unknown as DedicatedWorkerGlobalScope
let model: FaceLandmarker | null = null
let policy: QualityPolicy | null = null
const crop = new OffscreenCanvas(128, 128)
const context = crop.getContext('2d', { willReadFrequently: true })

worker.onmessage = async ({ data }: MessageEvent<WorkerRequest>) => {
  try {
    if (data.type === 'init') {
      validatePolicy(data.policy!)
      policy = data.policy!
      const files = await FilesetResolver.forVisionTasks('/vision/tasks-vision-1.2.3', true)
      model = await FaceLandmarker.createFromOptions(files, {
        baseOptions: { modelAssetPath: '/vision/face-landmarker-64184e229b263107.task', delegate: 'CPU' },
        runningMode: 'VIDEO', numFaces: 2, outputFacialTransformationMatrixes: true, outputFaceBlendshapes: false,
        minFaceDetectionConfidence: .6, minFacePresenceConfidence: .6, minTrackingConfidence: .6,
      })
      worker.postMessage({ type: 'ready', id: data.id } satisfies WorkerReply)
      return
    }
    if (!model || !policy || !data.bitmap || !context) throw new Error('Tracker is not ready')
    const bitmap = data.bitmap
    const result = model.detectForVideo(bitmap, data.timestamp ?? performance.now())
    const frame: FrameAssessment = { faceCount: result.faceLandmarks.length, orientation: null, issue: null, score: 0, brightness: 0, sharpness: 0 }
    if (frame.faceCount === 1) {
      const points = result.faceLandmarks[0]
      const matrix = result.facialTransformationMatrixes[0]?.data
      frame.orientation = matrix ? orientationFromMatrix(matrix) : null
      const box = faceBounds(points)
      if (!box || !frame.orientation || box.width <= 0 || box.height <= 0) frame.issue = 'alignment'
      else {
        context.drawImage(bitmap, Math.max(0, box.x) * bitmap.width, Math.max(0, box.y) * bitmap.height,
          box.width * bitmap.width, box.height * bitmap.height, 0, 0, 128, 128)
        Object.assign(frame, pixelQuality(context.getImageData(0, 0, 128, 128).data, 128, 128))
        const eyes = Math.min(eyeAspectRatio(points, [33, 160, 158, 133, 153, 144], bitmap.width, bitmap.height),
          eyeAspectRatio(points, [362, 385, 387, 263, 373, 380], bitmap.width, bitmap.height))
        frame.issue = qualityIssue(box, frame.brightness, frame.sharpness, eyes, policy)
        frame.score = qualityScore(frame.brightness, frame.sharpness)
      }
    }
    worker.postMessage({ type: 'frame', id: data.id, frame } satisfies WorkerReply)
  } catch {
    worker.postMessage({ type: 'error', id: data.id } satisfies WorkerReply)
  } finally { data.bitmap?.close() }
}
