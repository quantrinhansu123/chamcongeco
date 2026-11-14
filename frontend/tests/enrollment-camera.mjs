import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { cameraArgs, consent, fakeTracker, instrumentCamera, openEnrollment, png } from './helpers/enrollment.mjs'

test('automatically selects all five poses, stops camera, submits once and retakes only a rejected angle',async()=>{
  const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL,args:cameraArgs})
  try{
    const page=await browser.newPage({viewport:{width:1440,height:1100}})
    const errors=[];page.on('pageerror',error=>errors.push(error.message))
    await instrumentCamera(page);await fakeTracker(page);await openEnrollment(page)
    assert.equal(await page.getByRole('button',{name:'Bắt đầu thu 5 góc',exact:true}).isDisabled(),true)
    assert.equal(await page.evaluate(()=>window.trackerCount),0,'no model worker until explicit start')
    await consent(page)
    let posts=0,body=''
    await page.route('**/api/employees',route=>{
      if(route.request().method()==='GET')return route.fulfill({json:[]})
      posts++;body=route.request().postDataBuffer().toString()
      return route.fulfill(posts===1?{status:422,json:{code:'face_blurry',detail:'Ảnh góc phải đang mờ.',image_index:2}}:{status:201,json:{name:'Synthetic Automatic',employee_id:'emp_001',template_count:5}})
    })
    await page.getByRole('button',{name:'Bắt đầu thu 5 góc',exact:true}).click()
    await page.getByText('Đã kiểm tra 5/5 góc',{exact:true}).waitFor({timeout:30_000})
    assert.equal(await page.locator('.pose-card img').count(),5)
    assert.equal(posts,0,'capture alone never enrolls')
    assert.equal(await page.locator('video').evaluate(video=>video.srcObject),null)
    assert.equal(await page.evaluate(()=>window.workerPeak),1,'at most one frame in flight')
    assert.equal(await page.evaluate(()=>window.cameraStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),true)
    await page.getByRole('button',{name:'Lưu nhân viên',exact:true}).click()
    await page.getByRole('alert').filter({hasText:'Ảnh góc phải đang mờ.'}).waitFor()
    assert.equal(await page.locator('.pose-card.invalid').count(),1)
    assert.equal(await page.getByRole('button',{name:'Lưu nhân viên',exact:true}).isDisabled(),true)
    const firstSrc=await page.locator('.pose-card img').first().getAttribute('src')
    const rightSrc=await page.locator('.pose-card img').nth(2).getAttribute('src')
    await page.getByRole('button',{name:'Chụp lại góc Quay phải',exact:true}).click()
    await page.locator('.auto-capture[data-capture-state="review"]').waitFor({timeout:20_000})
    assert.equal(await page.locator('.pose-card img').first().getAttribute('src'),firstSrc)
    assert.notEqual(await page.locator('.pose-card img').nth(2).getAttribute('src'),rightSrc)
    await page.getByRole('button',{name:'Lưu nhân viên',exact:true}).focus();await page.keyboard.press('Enter')
    await page.getByRole('status').filter({hasText:'Đăng ký thành công'}).waitFor()
    assert.equal(posts,2)
    assert.equal((body.match(/name="image"/g)||[]).length,5)
    assert.match(body,/name="capture_mode"\r\n\r\nguided/)
    assert.match(body,/\["front","left","right","up","down"\]/)
    assert.match(body,/name="consent"\r\n\r\ntrue/)
    assert.equal(await page.evaluate(()=>window.trackerCount===window.trackerTerminated),true)
    for(const width of [1440,390,320]){
      await page.setViewportSize({width,height:1000})
      await page.evaluate(()=>window.scrollTo(0,0))
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`overflow at ${width}`)
      await page.screenshot({path:`node_modules/.cache/guided-enrollment-${width}.png`,fullPage:true,animations:'disabled'})
    }
    assert.deepEqual(errors,[])
  }finally{await browser.close()}
})

test('multiple faces and blurry frames never produce samples; switching screens closes camera and worker',async()=>{
  const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL,args:cameraArgs})
  try{
    const page=await browser.newPage()
    await instrumentCamera(page);await fakeTracker(page,{faceCount:2});await openEnrollment(page);await consent(page)
    await page.getByRole('button',{name:'Bắt đầu thu 5 góc',exact:true}).click()
    await page.getByText('Chỉ một người đứng trước camera.',{exact:true}).waitFor()
    assert.equal(await page.locator('.pose-card img').count(),0)
    await page.getByRole('button',{name:'Dừng thu',exact:true}).click()
    await fakeTracker(page,{issue:'blurry'})
    await page.getByRole('button',{name:'Bắt đầu thu 5 góc',exact:true}).click()
    await page.getByText('Ảnh đang mờ. Giữ yên và kiểm tra ống kính camera.',{exact:true}).waitFor()
    assert.equal(await page.locator('.pose-card img').count(),0)
    await page.getByRole('button',{name:'Chấm công',exact:true}).click()
    assert.equal(await page.evaluate(()=>window.cameraStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),true)
    assert.equal(await page.evaluate(()=>window.trackerCount===window.trackerTerminated),true)
  }finally{await browser.close()}
})

test('cancel during initialization releases a late camera and upload fallback stays available',async()=>{
  const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL,args:cameraArgs})
  try{
    const page=await browser.newPage()
    const errors=[];page.on('pageerror',e=>errors.push(e.message))
    await instrumentCamera(page);await fakeTracker(page,{readyDelay:1500});await openEnrollment(page);await consent(page)
    await page.evaluate(()=>{const media=navigator.mediaDevices.getUserMedia;navigator.mediaDevices.getUserMedia=async options=>{await new Promise(r=>setTimeout(r,700));return media(options)}})
    await page.getByRole('button',{name:'Bắt đầu thu 5 góc',exact:true}).click()
    await page.getByRole('button',{name:'Dừng thu',exact:true}).click()
    await page.waitForTimeout(1800)
    assert.equal(await page.evaluate(()=>window.cameraStreams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))),true)
    await page.evaluate(()=>{navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Denied','NotAllowedError')}})
    await page.getByRole('button',{name:'Bắt đầu thu 5 góc',exact:true}).click()
    await page.getByRole('alert').filter({hasText:'Quyền camera bị từ chối'}).waitFor()
    await page.getByRole('button',{name:'Tải ảnh lên',exact:true}).click()
    await page.locator('input[type=file]').setInputFiles(png)
    assert.equal(await page.locator('.upload-previews img').count(),1)
    assert.equal(await page.getByRole('button',{name:'Lưu nhân viên',exact:true}).isEnabled(),true)
    assert.deepEqual(errors,[])
  }finally{await browser.close()}
})
