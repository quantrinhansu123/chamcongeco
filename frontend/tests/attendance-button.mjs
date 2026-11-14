import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright'

test('attendance button starts recognition, shows readable names and times, and stops the camera', async () => {
  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  })
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    await page.addInitScript(()=>{
      window.cameraControls=[]
      const media=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      navigator.mediaDevices.getUserMedia=async options=>{
        const stream=await media(options)
        for(const track of stream.getVideoTracks()){
          track.getCapabilities=()=>({focusMode:['continuous'],exposureMode:['continuous']})
          track.applyConstraints=async constraints=>{window.cameraControls.push(constraints);throw new DOMException('Unsupported fake driver','OverconstrainedError')}
        }
        return stream
      }
    })
    let arrived = false
    let departed = false
    let failure = null
    let requests = 0
    await page.route('**/api/session', route => route.fulfill({ json: { role: 'admin', authentication_required: false } }))
    await page.route('**/api/recognition-requests/*', route => route.fulfill({ json: { status: 'not_found' } }))
    await page.route('**/api/employees', route => route.fulfill({ json: [{
      employee_id: 'EMP001', name: 'Nguyễn Thị Minh Anh', is_arrive: arrived,
      arrived_at: arrived ? '2026-11-14T01:30:00Z' : null,
      departed_at: departed ? '2026-11-14T10:30:00Z' : null,
    }] }))
    await page.route('**/api/recognize', route => {
      requests++
      if (failure) return route.fulfill({ status: failure.status, json: { detail: failure.message, code: failure.status === 403 ? 'spoof_detected' : 'storage_unavailable' } })
      assert.match(route.request().postDataBuffer().toString(), /name="action"\r\n\r\nauto/)
      if (arrived) departed = true
      const alreadyArrived = arrived
      arrived = true
      return route.fulfill({ json: {
        faces: [{ employee_id: 'EMP001', name: 'Nguyễn Thị Minh Anh', distance: 0.2,
          location: { top: 80, left: 80, right: 200, bottom: 200 } }],
        attendance_updated: alreadyArrived && !departed ? [] : ['EMP001'],
        status: 'confirmed', request_id: 'test', action: departed ? 'out' : 'in', replayed: false,
        attendance: [{ employee_id: 'EMP001', name: 'Nguyễn Thị Minh Anh', is_arrive: true,
          arrived_at: '2026-11-14T01:30:00Z', departed_at: departed ? '2026-11-14T10:30:00Z' : null }],
      } })
    })
    await page.goto(process.env.FRONTEND_URL || 'http://127.0.0.1:5173')
    await page.locator('.employee-name').waitFor()
    assert.equal(requests, 0)
    await page.getByLabel('Tìm nhân viên').fill('missing')
    await page.getByText('Không tìm thấy nhân viên phù hợp.').waitFor()
    await page.getByLabel('Tìm nhân viên').fill('emp001')
    assert.equal(await page.locator('.employee-name').count(), 1)
    await page.getByLabel('Tìm nhân viên').fill('')
    await page.locator('.attendance-button').click()
    await page.locator('.attendance-confirmation-badge').getByText('Đã lưu', { exact: true }).waitFor()
    assert.equal(requests, 1)
    await page.locator('#main-content').getByRole('button', { name: 'Chấm công', exact: true }).waitFor()
    assert.equal(await page.locator('video').evaluate(video => video.srcObject), null)
    await page.waitForTimeout(1200)
    assert.equal(requests, 1, 'must not record checkout automatically')
    assert.equal(departed, false)
    assert.equal(await page.getByRole('group', { name: 'Loại chấm công' }).count(), 0)
    assert.equal(await page.locator('.arrival-time time').first().innerText(), '08:30:00')
    for (const selector of ['.arrival-time time', '.attendance-confirmation-copy strong']) {
      assert.equal(await page.locator(selector).first().evaluate(element => getComputedStyle(element).fontSize), '20px')
    }
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflows at ${width}`)
      const name = page.locator('.employee-name')
      assert.equal(await name.evaluate(element => element.scrollWidth <= element.clientWidth), true)
      await page.screenshot({ path: `node_modules/.cache/attendance-result-${width}.png`, fullPage: true, animations: 'disabled' })
    }
    // Reopening records checkout with one click and preserves the arrival.
    await page.reload()
    await page.locator('.employee-name').waitFor()
    await page.locator('#main-content').getByRole('button', { name: 'Chấm công', exact: true }).focus()
    await page.keyboard.press('Enter')
    await page.getByText('Đã ghi giờ ra: 17:30:00', { exact: true }).waitFor()
    assert.equal(departed, true)
    assert.equal(requests, 2, 'reopening needs only one click to check out')
    assert.equal(await page.locator('.arrival-time time').first().innerText(), '08:30:00')
    assert.equal(await page.locator('#main-content').getByRole('button', { name: 'Chấm công', exact: true }).isDisabled(), true)
    assert.equal(await page.locator('video').evaluate(video => video.srcObject), null)
    await page.getByRole('button', { name: 'Chấm công người khác', exact: true }).click()
    failure = { status: 403, message: 'Photo or screen replay detected' }
    await page.locator('#main-content').getByRole('button', { name: 'Chấm công', exact: true }).click()
    await page.getByRole('alert').getByText('Phát hiện ảnh hoặc màn hình', { exact: true }).waitFor()
    assert.equal(await page.locator('.attendance-confirmation').count(), 0)
    failure = { status: 503, message: 'Máy chủ đang bận. Vui lòng thử lại.' }
    await page.getByRole('status').getByText(failure.message, { exact: true }).waitFor()
    assert.equal(await page.locator('.attendance-confirmation').count(), 0)
    await page.getByRole('button', { name: 'Dừng chấm công', exact: true }).click()
    await page.locator('#main-content').getByRole('button', { name: 'Chấm công', exact: true }).last().waitFor()
    assert.equal(await page.locator('video').evaluate(video => video.srcObject), null)
    assert.deepEqual(await page.evaluate(()=>window.cameraControls),[
      {advanced:[{focusMode:'continuous'}]}, {advanced:[{exposureMode:'continuous'}]},
      {advanced:[{focusMode:'continuous'}]}, {advanced:[{exposureMode:'continuous'}]},
    ])
  } finally {
    await browser.close()
  }
})
