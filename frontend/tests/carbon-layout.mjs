// Start the frontend first. PLAYWRIGHT_CHANNEL=msedge uses installed Edge on Windows.
import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { test } from 'node:test'
import { chromium } from 'playwright'

async function checkTypography(page, controls) {
  await page.evaluate(() => document.fonts.ready)
  for (const [selector, size, weight] of controls) {
    const style = await page.locator(selector).first().evaluate(element => {
      const style = getComputedStyle(element)
      return { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight }
    })
    assert.match(style.family, /^Inter/, selector)
    assert.equal(style.size, `${size}px`, selector)
    assert.equal(style.weight, `${weight}`, selector)
  }
  assert.equal(await page.evaluate(() => [...document.fonts].some(font => font.status === 'error')), false)
  assert.equal(await page.evaluate(() => [...document.fonts].some(font => font.family === 'Inter' && font.status === 'loaded')), true)
}

test('Carbon navigation works on desktop and mobile without horizontal overflow', async () => {
  const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL })
  try {
    const page = await browser.newPage({ reducedMotion: 'reduce' })
    const errors = []
    await page.route('**/api/session', route => route.fulfill({ json: { role: 'admin', authentication_required: false } }))
    page.on('pageerror', error => errors.push(error.message))
    await page.route('**/api/employees', route => route.fulfill({ json: [] }))
    await mkdir('node_modules/.cache/layout-preview', { recursive: true })
    for (const width of [1440, 1024, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 })
      await page.goto(process.env.FRONTEND_URL || 'http://127.0.0.1:5173')
      await page.getByRole('heading', { name: 'Chấm công', exact: true }).waitFor()
      await page.getByText('Chưa có nhân viên.', { exact: false }).waitFor()
      await page.keyboard.press('Tab')
      assert.equal(await page.locator(':focus').innerText(), 'Đến nội dung chính')
      await page.keyboard.press('Enter')
      assert.equal(await page.locator('#main-content').evaluate(el => el === document.activeElement), true)
      await checkTypography(page, [
        ['h1', 32, 400], ['.panel-header h2', 20, 400],
        ['.employee-card-header h3', 16, 600],
        ['.attendance-button', 14, 400], ['.camera-placeholder p', 14, 400],
      ])
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `attendance overflows at ${width}`)
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.screenshot({ path: `node_modules/.cache/layout-preview/attendance-${width}.png`, fullPage: true })
      if (width < 1056) await page.getByRole('button', { name: 'Mở menu', exact: true }).click()
      await page.getByRole('button', { name: 'Đăng ký nhân viên', exact: true }).click()
      await page.getByRole('heading', { name: 'Đăng ký nhân viên', exact: true }).waitFor()
      await checkTypography(page, [
        ['h1', 32, 400], ['.panel-header h2', 20, 400],
        ['#employee-name', 14, 400], ['.enrollment-submit', 14, 400],
        ['.consent-box', 14, 400],
      ])
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `enrollment overflows at ${width}`)
      await page.evaluate(() => window.scrollTo(0, 0))
      await page.screenshot({ path: `node_modules/.cache/layout-preview/enrollment-${width}.png`, fullPage: true })
      if (width < 1056) {
        const toggle = page.getByRole('button', { name: 'Mở menu', exact: true })
        await toggle.click()
        await page.getByRole('button', { name: 'Chấm công', exact: true }).focus()
        await page.keyboard.press('Escape')
        await toggle.waitFor()
        await toggle.click()
      }
      await page.getByRole('button', { name: 'Chấm công', exact: true }).click()
      await page.getByRole('heading', { name: 'Chấm công', exact: true }).waitFor()
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
