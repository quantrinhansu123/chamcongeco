// With the frontend running and Playwright available: node --test tests/enrollment-camera.mjs
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright'

test('enrollment captures, retakes, uploads, and releases its camera', async () => {
  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  })
  try {
    const page = await browser.newPage()
    let enrollmentBody = ''
    let recognitionRequests = 0
    await page.route('**/api/employees', async (route) => {
      if (route.request().method() === 'POST') {
        enrollmentBody = route.request().postDataBuffer().toString()
        await route.fulfill({ json: { name: 'Alice', employee_id: 'EMP001' } })
      } else {
        await route.fulfill({ json: [] })
      }
    })
    await page.route('**/api/recognize', async (route) => {
      recognitionRequests++
      await route.fulfill({ json: { faces: [], attendance_updated: [] } })
    })
    await page.addInitScript(() => {
      window.cameraStreams = []
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia = async (options) => {
        const stream = await getUserMedia(options)
        window.cameraStreams.push(stream)
        return stream
      }
    })
    await page.goto(process.env.FRONTEND_URL || 'http://127.0.0.1:5173')
    await page.getByRole('button', { name: 'Đăng ký nhân viên', exact: true }).click()
    await page.getByRole('button', { name: 'Mở camera', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('video')?.videoWidth > 0)
    await page.getByRole('button', { name: 'Chụp ảnh', exact: true }).click()
    await page.getByAltText('Ảnh khuôn mặt nhân viên').waitFor()
    assert.equal(await page.getByLabel('Họ và tên', { exact: true }).inputValue(), '')
    assert.equal(await page.evaluate(() => window.cameraStreams[0].getTracks()[0].readyState), 'ended')
    await page.getByLabel('Họ và tên', { exact: true }).fill('Alice')
    assert.equal(await page.getByRole('button', { name: 'Lưu nhân viên', exact: true }).isDisabled(), true)
    await page.getByRole('checkbox').focus()
    await page.keyboard.press('Space')
    await page.getByRole('button', { name: 'Lưu nhân viên', exact: true }).click()
    await page.getByRole('status').filter({ hasText: 'Đăng ký thành công' }).waitFor()
    assert.match(enrollmentBody, /name="name"\r\n\r\nAlice/)
    assert.match(enrollmentBody, /filename="employee-photo.jpg"\r\nContent-Type: image\/jpeg/)
    await page.getByRole('button', { name: 'Chụp lại' }).click()
    await page.getByRole('button', { name: 'Chụp ảnh', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Hủy chụp' }).click()
    await page.getByAltText('Ảnh khuôn mặt nhân viên').waitFor()
    await page.getByRole('button', { name: 'Chụp lại' }).click()
    await page.getByRole('button', { name: 'Chụp ảnh', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Chấm công', exact: true }).click()
    assert.equal(await page.evaluate(() => window.cameraStreams.every(s => s.getTracks().every(t => t.readyState === 'ended'))), true)
    assert.equal(recognitionRequests, 0)
    await page.getByRole('button', { name: 'Đăng ký nhân viên', exact: true }).click()
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError') }
    })
    await page.getByRole('button', { name: 'Mở camera', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Quyền camera bị từ chối' }).waitFor()
    await page.locator('input[type=file]').setInputFiles({
      name: 'alice.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=', 'base64'),
    })
    await page.getByAltText('Ảnh khuôn mặt nhân viên').waitFor()
    assert.equal(await page.getByLabel('Họ và tên', { exact: true }).inputValue(), 'Alice')
  } finally {
    await browser.close()
  }
})
