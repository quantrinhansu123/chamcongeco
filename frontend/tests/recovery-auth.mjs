import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright'

const url = process.env.FRONTEND_URL || 'http://127.0.0.1:5173'
const employee = { employee_id: 'emp_001', name: 'Synthetic Recovery', is_arrive: false, arrived_at: null, departed_at: null }
const receipt = id => ({ request_id: id, status: 'confirmed', action: 'in', replayed: true,
  faces: [{ employee_id: employee.employee_id, name: employee.name, distance: .1, location: { top: 10, left: 10, right: 150, bottom: 150 } }],
  attendance_updated: ['emp_001'], attendance: [{ ...employee, is_arrive: true, arrived_at: '2026-11-14T01:30:00Z' }] })

test('lost success response recovers its durable receipt without a second punch', async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] })
  try {
    const page = await browser.newPage()
    let posts = 0
    let id
    await page.route('**/api/session', route => route.fulfill({ json: { role: 'admin', authentication_required: false } }))
    await page.route('**/api/employees', route => route.fulfill({ json: [employee] }))
    await page.route('**/api/recognize', route => {
      posts++
      id = route.request().postDataBuffer().toString().match(/name="request_id"\r\n\r\n([^\r]+)/)[1]
      return route.abort('connectionreset')
    })
    await page.route('**/api/recognition-requests/*', route => route.fulfill({ json: receipt(id) }))
    await page.goto(url)
    await page.locator('.employee-name').waitFor()
    await page.locator('.attendance-button').click()
    await page.getByText('Đã ghi giờ vào: 08:30:00', { exact: true }).waitFor()
    assert.equal(posts, 1)
    assert.equal(await page.locator('video').evaluate(video => video.srcObject), null)
    assert.equal(await page.evaluate(() => sessionStorage.getItem('attendly.pending-punch')), null)
    // Reload with an unresolved request: recover before opening the camera.
    await page.evaluate(() => sessionStorage.setItem('attendly.pending-punch', '5e7a3b8a-766a-40bf-bd90-707a0bfed3ce'))
    await page.reload()
    await page.locator('.employee-name').waitFor()
    await page.locator('.attendance-button').click()
    await page.locator('.attendance-confirmation-badge').waitFor()
    assert.equal(posts, 1)
  } finally { await browser.close() }
})

test('production access key is sent in headers and kiosk has no enrollment controls', async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } })
    const key = 'synthetic-kiosk-access-key-32-characters'
    await page.route('**/api/session', route => route.fulfill(route.request().headers().authorization === `Bearer ${key}`
      ? { json: { role: 'kiosk', authentication_required: true } }
      : { status: 401, json: { code: 'authentication_required', detail: 'Nhập mã truy cập của trạm để tiếp tục.' } }))
    await page.route('**/api/employees', route => {
      assert.equal(route.request().headers().authorization, `Bearer ${key}`)
      return route.fulfill({ json: [{ ...employee, requires_reenrollment: true }] })
    })
    await page.goto(url)
    await page.getByLabel('Mã truy cập', { exact: true }).fill(key)
    await page.getByRole('button', { name: 'Tiếp tục', exact: true }).click()
    await page.locator('.employee-name').waitFor()
    assert.equal(await page.getByRole('button', { name: 'Đăng ký nhân viên', exact: true }).count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Cập nhật ảnh', exact: true }).count(), 0)
    assert.equal(await page.locator('.attendance-button').isDisabled(), true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.getByRole('button', { name: 'Mở menu', exact: true }).click()
    await page.getByRole('button', { name: 'Khóa phiên truy cập', exact: true }).click()
    await page.getByRole('heading', { name: 'Truy cập trạm chấm công', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => sessionStorage.getItem('attendly.access-key')), null)
  } finally { await browser.close() }
})

test('admin replaces legacy face templates through PUT with explicit consent', async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage()
    let updated = false
    await page.route('**/api/session', route => route.fulfill({ json: { role: 'admin', authentication_required: false } }))
    await page.route('**/api/employees', route => route.fulfill({ json: [{ ...employee, requires_reenrollment: true }] }))
    await page.route('**/api/employees/emp_001/face', route => {
      assert.equal(route.request().method(), 'PUT')
      assert.match(route.request().postDataBuffer().toString(), /name="consent"\r\n\r\ntrue/)
      updated = true
      return route.fulfill({ json: { employee_id: 'emp_001', name: employee.name, template_count: 1 } })
    })
    await page.goto(url)
    await page.getByRole('button', { name: `Cập nhật khuôn mặt ${employee.name}`, exact: true }).click()
    assert.equal(await page.getByLabel('Họ và tên', { exact: true }).inputValue(), employee.name)
    assert.equal(await page.getByLabel('Họ và tên', { exact: true }).getAttribute('readonly'), '')
    await page.getByRole('button', { name: 'Tải ảnh lên', exact: true }).click()
    await page.locator('input[type=file]').setInputFiles({ name: 'synthetic.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=', 'base64') })
    await page.getByRole('checkbox').focus()
    await page.keyboard.press('Space')
    await page.getByRole('button', { name: 'Lưu nhân viên', exact: true }).click()
    await page.getByRole('status').filter({ hasText: 'Đăng ký thành công' }).waitFor()
    assert.equal(updated, true)
  } finally { await browser.close() }
})
