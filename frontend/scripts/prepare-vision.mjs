// Self-hosted, pinned resources. No camera data is ever sent to a CDN.
import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const directory = resolve(root, 'public/vision')
const modelName = 'face-landmarker-64184e229b263107.task'
const modelHash = '64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff'
const sdk = [
  ['vision_wasm_module_internal.js', 'd29996249490361715c769c6a49b43ad47e6ac9a28a8e8bce8d02b238e897851'],
  ['vision_wasm_module_internal.wasm', 'a269e84b12aefc93c9d6a4d62b01f41e5434a9fa941533bb8e75b1e3d1669e46'],
]
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function valid(path, expected) { try { return hash(await readFile(path)) === expected } catch { return false } }
async function atomic(path, bytes) {
  const temporary = `${path}.${process.pid}.tmp`
  try { await writeFile(temporary, bytes); await rename(temporary, path) }
  finally { await rm(temporary, { force: true }) }
}
await mkdir(resolve(directory, 'tasks-vision-1.2.3'), { recursive: true })
for (const [filename, expected] of sdk) {
  const bytes = await readFile(resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm', filename))
  if (hash(bytes) !== expected) throw new Error(`Unexpected MediaPipe SDK asset: ${filename}`)
  const target = resolve(directory, 'tasks-vision-1.2.3', filename)
  if (!await valid(target, expected)) await atomic(target, bytes)
}
const target = resolve(directory, modelName)
if (!await valid(target, modelHash)) {
  let lastError
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch('https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task', { signal: AbortSignal.timeout(60_000) })
      if (!response.ok) throw new Error(`Model download returned HTTP ${response.status}`)
      const bytes = Buffer.from(await response.arrayBuffer())
      if (bytes.length !== 3758596 || hash(bytes) !== modelHash) throw new Error('Face Landmarker model checksum mismatch')
      await atomic(target, bytes)
      lastError = null
      break
    } catch (error) { lastError = error }
  }
  if (lastError) throw new Error('Cannot prepare the camera model. Check network access, or copy verified assets to frontend/public/vision before running again.', { cause: lastError })
}
console.log('Verified self-hosted Face Landmarker model and MediaPipe 1.2.3 WASM.')
