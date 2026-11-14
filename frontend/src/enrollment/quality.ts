import type { FrameAssessment, QualityPolicy } from './types'
export interface Point { x: number; y: number; z?: number }
export interface Bounds { x: number; y: number; width: number; height: number }

export function faceBounds(points: readonly Point[]): Bounds | null {
  if (points.length < 468 || points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null
  const xs = points.map(point => point.x), ys = points.map(point => point.y)
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y }
}

export function eyeAspectRatio(points: readonly Point[], indices: readonly number[], width: number, height: number): number {
  const distance = (a: number, b: number) => Math.hypot((points[a].x - points[b].x) * width, (points[a].y - points[b].y) * height)
  return (distance(indices[1], indices[5]) + distance(indices[2], indices[4])) / Math.max(1e-5, 2 * distance(indices[0], indices[3]))
}

/** Face crop normalized to a fixed resolution; independent of webcam megapixels. */
export function pixelQuality(rgba: Uint8ClampedArray, width: number, height: number) {
  const gray = new Float32Array(width * height)
  let sum = 0
  for (let i = 0; i < gray.length; i++) {
    gray[i] = rgba[i * 4] * .299 + rgba[i * 4 + 1] * .587 + rgba[i * 4 + 2] * .114
    sum += gray[i]
  }
  let laplacian = 0, squared = 0, count = 0
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x
    const value = gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * gray[i]
    laplacian += value; squared += value * value; count++
  }
  return { brightness: sum / Math.max(1, gray.length), sharpness: Math.max(0, squared / Math.max(1, count) - (laplacian / Math.max(1, count)) ** 2) }
}

export function validatePolicy(policy: QualityPolicy): void {
  if (!policy || policy.version !== 'face-quality-v2' || policy.crop_size !== 128 ||
    ![policy.min_sharpness, policy.min_brightness, policy.max_brightness, policy.min_face_pixels].every(Number.isFinite) ||
    policy.min_sharpness < 0 || policy.min_brightness < 0 || policy.max_brightness > 255 ||
    policy.min_brightness >= policy.max_brightness || policy.min_face_pixels < 24) {
    throw new Error('Bộ hướng dẫn camera chưa khớp với máy chủ. Tải lại trang rồi thử lại.')
  }
}

/** Prefer detail among already valid, stable frames; do not saturate sharpness. */
export function qualityScore(brightness: number, sharpness: number): number {
  return Math.log1p(Math.max(0, sharpness)) * 100 - Math.abs(brightness - 130) * .35
}

export function qualityIssue(box: Bounds, brightness: number, sharpness: number, eyes: number, policy: QualityPolicy): FrameAssessment['issue'] {
  if (box.width < .23 || box.height < .28) return 'too-small'
  if (box.width > .78 || box.height > .88) return 'too-close'
  if (box.x < .015 || box.y < .015 || box.x + box.width > .985 || box.y + box.height > .985) return 'cropped'
  if (brightness < policy.min_brightness) return 'dark'
  if (brightness > policy.max_brightness) return 'bright'
  if (sharpness < policy.min_sharpness) return 'blurry'
  if (eyes < .13) return 'eyes-closed'
  return null
}
