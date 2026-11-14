export const POSES = [
  { id: 'front', label: 'Nhìn thẳng', instruction: 'Nhìn thẳng vào camera và giữ yên.' },
  { id: 'left', label: 'Quay trái', instruction: 'Quay mặt nhẹ sang trái của bạn.' },
  { id: 'right', label: 'Quay phải', instruction: 'Quay mặt nhẹ sang phải của bạn.' },
  { id: 'up', label: 'Ngẩng nhẹ', instruction: 'Ngẩng cằm lên một chút.' },
  { id: 'down', label: 'Cúi nhẹ', instruction: 'Hạ cằm xuống một chút.' },
] as const
export type PoseId = typeof POSES[number]['id']
export interface Orientation { yaw: number; pitch: number; roll: number }
export interface FrameAssessment {
  faceCount: number
  orientation: Orientation | null
  issue: 'no-face' | 'multiple-faces' | 'alignment' | 'too-small' | 'too-close' | 'cropped' | 'dark' | 'bright' | 'blurry' | 'eyes-closed' | null
  score: number
  brightness: number
  sharpness: number
}
export interface CapturedPhoto {
  pose: PoseId
  file: File
  url: string
  orientation: Orientation
}
export interface QualityPolicy {
  version: 'face-quality-v2'
  crop_size: 128
  min_sharpness: number
  min_brightness: number
  max_brightness: number
  min_face_pixels: number
}
export interface EnrollmentValidation {
  valid: true
  pose: PoseId
  reference_checked: boolean
  quality: { brightness: number; sharpness: number; face_pixels: number; policy_version: string } | null
}
export interface WorkerRequest { type: 'init' | 'frame'; id: number; bitmap?: ImageBitmap; timestamp?: number; policy?: QualityPolicy }
export type WorkerReply = { type: 'ready'; id: number } | { type: 'frame'; id: number; frame: FrameAssessment } | { type: 'error'; id: number }
