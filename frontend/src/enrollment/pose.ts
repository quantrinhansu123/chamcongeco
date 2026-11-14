import type { FrameAssessment, Orientation, PoseId } from './types'

const degrees = 180 / Math.PI

/** MediaPipe's canonical-to-camera matrix is flattened column-major. */
export function orientationFromMatrix(matrix: readonly number[]): Orientation | null {
  if (matrix.length !== 16 || matrix.some(value => !Number.isFinite(value))) return null
  const x = Math.hypot(matrix[0], matrix[1], matrix[2])
  const y = Math.hypot(matrix[4], matrix[5], matrix[6])
  const z = Math.hypot(matrix[8], matrix[9], matrix[10])
  if (Math.min(x, y, z) < 1e-5) return null
  return {
    yaw: Math.asin(Math.max(-1, Math.min(1, -matrix[2] / x))) * degrees,
    pitch: Math.atan2(matrix[6] / y, matrix[10] / z) * degrees,
    roll: Math.atan2(matrix[1] / x, matrix[0] / x) * degrees,
  }
}

export function poseMatches(pose: PoseId, angle: Orientation, baseline?: Orientation): boolean {
  const yaw = angle.yaw - (baseline?.yaw ?? 0)
  const pitch = angle.pitch - (baseline?.pitch ?? 0)
  if (Math.abs(angle.roll) > 15) return false
  if (pose === 'front') return Math.abs(angle.yaw) <= 12 && Math.abs(angle.pitch) <= 15
  // Positive yaw points toward the subject's left in the unmirrored camera
  // image. Mirror only the preview, never the pixels fed into the model.
  if (pose === 'left') return yaw >= 16 && yaw <= 30 && Math.abs(pitch) <= 12
  if (pose === 'right') return yaw <= -16 && yaw >= -30 && Math.abs(pitch) <= 12
  if (pose === 'up') return pitch <= -9 && pitch >= -22 && Math.abs(yaw) <= 12
  return pitch >= 9 && pitch <= 22 && Math.abs(yaw) <= 12
}

export const ISSUE_HINTS: Record<NonNullable<FrameAssessment['issue']>, string> = {
  'no-face': 'Đưa khuôn mặt vào khung hướng dẫn.',
  'multiple-faces': 'Chỉ một người đứng trước camera.',
  alignment: 'Hãy nhìn rõ vào camera để xác định khuôn mặt.',
  'too-small': 'Hãy đến gần camera hơn.',
  'too-close': 'Lùi ra một chút để thấy toàn bộ khuôn mặt.',
  cropped: 'Đưa toàn bộ khuôn mặt vào giữa khung hình.',
  dark: 'Khuôn mặt đang tối. Hãy bổ sung ánh sáng phía trước.',
  bright: 'Ánh sáng đang quá gắt. Hãy tránh nguồn sáng chiếu thẳng.',
  blurry: 'Ảnh đang mờ. Giữ yên và kiểm tra ống kính camera.',
  'eyes-closed': 'Mở mắt tự nhiên và nhìn về phía camera.',
}

export interface GateDecision { progress: number; reset: boolean; replaceBest: boolean; capture: boolean; hint: string }

/** Time-based hold; repeated still frames/timers alone cannot fill pose slots. */
export class CaptureGate {
  private pose: PoseId
  private baseline?: Orientation
  private since: number | null = null
  private previous = 0
  private count = 0
  private anchor: Orientation | null = null
  private best = -Infinity
  constructor(pose: PoseId, baseline?: Orientation) { this.pose = pose; this.baseline = baseline }

  update(frame: FrameAssessment, now: number): GateDecision {
    const issue = frame.faceCount !== 1 ? frame.faceCount === 0 ? 'no-face' : 'multiple-faces' : frame.issue
    if (issue || !frame.orientation || !poseMatches(this.pose, frame.orientation, this.baseline)) {
      this.since = null
      this.best = -Infinity
      this.count = 0
      this.anchor = null
      return { progress: 0, reset: true, replaceBest: false, capture: false,
        hint: issue ? ISSUE_HINTS[issue] : Math.abs(frame.orientation?.roll ?? 0) > 15 ? 'Giữ đầu thẳng, không nghiêng sang vai.' : 'Xoay nhẹ theo hướng dẫn, giữ khuôn mặt trong khung.' }
    }
    const angle = frame.orientation
    const unstable = this.anchor && Math.max(Math.abs(angle.yaw - this.anchor.yaw), Math.abs(angle.pitch - this.anchor.pitch), Math.abs(angle.roll - this.anchor.roll)) > 3.5
    const reset = this.since === null || now - this.previous > 350 || !!unstable
    if (reset) { this.since = now; this.count = 0; this.best = -Infinity; this.anchor = angle }
    this.previous = now
    this.count++
    const held = now - (this.since ?? now)
    // Ignore the first settling frames after movement/autofocus before ranking.
    const replaceBest = held >= 200 && this.count >= 3 && frame.score > this.best
    if (replaceBest) this.best = frame.score
    const capture = held >= 700 && this.count >= 5 && Number.isFinite(this.best)
    return { progress: Math.min(100, Math.floor(held / 700 * 100)), reset, replaceBest, capture, hint: capture ? 'Đã chọn ảnh, chuẩn bị kiểm tra.' : 'Đúng góc. Giữ yên một chút…' }
  }
}
