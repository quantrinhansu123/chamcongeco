// Optional end-to-end smoke against a REAL, ISOLATED backend and a public
// developer fixture. Never run this against an operational employee database.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const image = process.env.REAL_FACE_IMAGE
const video = process.env.REAL_CAMERA_FIXTURE
if (!image || !video || process.env.CONFIRM_ISOLATED_BACKEND !== 'yes') throw new Error('Set REAL_FACE_IMAGE, REAL_CAMERA_FIXTURE, and CONFIRM_ISOLATED_BACKEND=yes. Use a disposable SQLite backend.')
const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL,
  args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-video-capture=${video}`] })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  const punches = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('response', async response => {
    if (response.url().endsWith('/api/recognize') && response.status() === 200) punches.push(await response.json())
  })
  await page.goto(process.env.FRONTEND_URL || 'http://127.0.0.1:5173')
  await page.getByRole('button', { name: 'Đăng ký nhân viên', exact: true }).click()
  await page.getByLabel('Họ và tên', { exact: true }).fill('Synthetic Real Pipeline')
  await page.getByRole('button', { name: 'Tải ảnh lên', exact: true }).click()
  await page.locator('input[type=file]').setInputFiles(image)
  await page.getByRole('checkbox').focus()
  await page.keyboard.press('Space')
  await page.getByRole('button', { name: 'Lưu nhân viên', exact: true }).click()
  await page.getByRole('status').filter({ hasText: 'Đăng ký thành công' }).waitFor()
  await page.getByRole('button', { name: 'Chuyển sang chấm công', exact: true }).click()
  await page.locator('.employee-name').waitFor()
  await page.locator('.attendance-button').click()
  await page.locator('.attendance-confirmation-badge').getByText('Đã lưu', { exact: true }).waitFor({ timeout: 30_000 })
  assert.equal(punches.length, 1)
  assert.equal(punches[0].status, 'confirmed')
  assert.equal(punches[0].attendance[0].name, 'Synthetic Real Pipeline')
  assert.equal(punches[0].attendance_updated.length, 1)
  assert.equal(await page.locator('video').evaluate(video => video.srcObject), null)
  const previous = await page.request.get(`${new URL(page.url()).origin}/api/recognition-requests/${punches[0].request_id}`)
  assert.equal(previous.status(), 200)
  assert.deepEqual((await previous.json()).attendance, punches[0].attendance)
  await page.waitForTimeout(1200)
  assert.equal(punches.length, 1)
  assert.deepEqual(errors, [])
  await page.screenshot({ path: 'node_modules/.cache/real-pipeline.png', fullPage: true, animations: 'disabled' })
  console.log('PASS: real UI -> multipart enrollment -> ONNX/PAD -> SQLite/private evidence -> receipt -> camera stop; synthetic identity/public sample, isolated DB.')
} finally { await browser.close() }
