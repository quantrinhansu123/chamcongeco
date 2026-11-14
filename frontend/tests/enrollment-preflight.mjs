import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chromium } from 'playwright'
import { cameraArgs, consent, fakeTracker, instrumentCamera, openEnrollment, policy } from './helpers/enrollment.mjs'

const photoRequest=route=>{
  const body=route.request().postDataBuffer().toString()
  return {pose:body.match(/name="pose"\r\n\r\n([a-z]+)/)?.[1],reference:body.includes('name="reference"'),body}
}

test('server checks every pose, automatically replaces blurry/wrong-person samples and retries backpressure',async()=>{
  const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL,args:cameraArgs})
  try{
    const page=await browser.newPage()
    await instrumentCamera(page);await fakeTracker(page);await openEnrollment(page);await consent(page)
    await page.route('**/api/enrollment/policy',route=>route.fulfill({json:{...policy,min_sharpness:62}}))
    const requests=[],attempts={};let inFlight=0,peak=0,employeePosts=0
    let releaseFirst
    const firstValidation=new Promise(resolve=>{releaseFirst=resolve})
    await page.route('**/api/employees',route=>{
      if(route.request().method()==='POST')employeePosts++
      return route.fulfill({json:[]})
    })
    await page.route('**/api/enrollment/validate',async route=>{
      const input=photoRequest(route);requests.push(input)
      attempts[input.pose]=(attempts[input.pose]||0)+1
      inFlight++;peak=Math.max(peak,inFlight)
      try{
        if(requests.length===1)await firstValidation
        await new Promise(resolve=>setTimeout(resolve,180))
        if(attempts[input.pose]===1&&input.pose==='front')return await route.fulfill({status:422,json:{code:'face_blurry',detail:'Ảnh đang mờ.'}})
        if(attempts[input.pose]===1&&input.pose==='left')return await route.fulfill({status:422,json:{code:'different_faces',detail:'Ảnh chưa khớp với góc nhìn thẳng.'}})
        if(attempts[input.pose]===1&&input.pose==='right')return await route.fulfill({status:429,json:{code:'busy',detail:'Máy chủ đang bận.'}})
        return await route.fulfill({json:{valid:true,pose:input.pose,reference_checked:input.reference,quality:null}})
      }finally{inFlight--}
    })
    await page.getByRole('button',{name:'Bắt đầu thu 5 góc',exact:true}).click()
    await page.locator('.auto-capture[data-capture-state="checking"]').waitFor()
    assert.equal(await page.locator('.pose-card img').count(),0,'unvalidated sample never fills a pose')
    assert.equal(await page.getByRole('button',{name:'Lưu nhân viên',exact:true}).isDisabled(),true)
    releaseFirst()
    await page.getByText('Đã kiểm tra 5/5 góc',{exact:true}).waitFor({timeout:35_000})
    await page.locator('.auto-capture[data-capture-state="review"]').waitFor()
    assert.deepEqual(attempts,{front:2,left:2,right:2,up:1,down:1})
    assert.equal(requests.filter(r=>r.pose!=='front').every(r=>r.reference),true)
    assert.equal(requests.every(r=>r.body.includes('name="consent"\r\n\r\ntrue')),true)
    assert.equal(peak,1)
    assert.equal(employeePosts,0,'preflight cannot enroll without explicit save')
    assert.equal(await page.evaluate(()=>window.workerInitPolicy.min_sharpness),62)
    assert.equal(await page.evaluate(()=>window.workerPeak),1)
    assert.equal(await page.locator('video').evaluate(video=>video.srcObject),null)
  }finally{await browser.close()}
})

test('cancel while server validates discards late responses and releases camera and worker',async()=>{
  const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL,args:cameraArgs})
  try{
    const page=await browser.newPage()
    await instrumentCamera(page);await fakeTracker(page);await openEnrollment(page);await consent(page)
    let release
    const responseGate=new Promise(resolve=>{release=resolve})
    await page.route('**/api/enrollment/validate',async route=>{
      const input=photoRequest(route)
      await responseGate
      try{await route.fulfill({json:{valid:true,pose:input.pose,reference_checked:input.reference,quality:null}})}catch{/* request was canceled */}
    })
    await page.getByRole('button',{name:'Bắt đầu thu 5 góc',exact:true}).click()
    await page.locator('.auto-capture[data-capture-state="checking"]').waitFor()
    await page.getByRole('button',{name:'Dừng thu',exact:true}).click()
    release()
    await page.waitForTimeout(250)
    assert.equal(await page.locator('.pose-card img').count(),0)
    assert.equal(await page.locator('video').evaluate(video=>video.srcObject),null)
    assert.equal(await page.evaluate(()=>window.cameraStreams.every(stream=>stream.getTracks().every(track=>track.readyState==='ended'))),true)
    assert.equal(await page.evaluate(()=>window.trackerCount===window.trackerTerminated),true)
    assert.equal(await page.getByRole('button',{name:'Lưu nhân viên',exact:true}).isDisabled(),true)
  }finally{await browser.close()}
})

test('persistent service failure stops bounded retries with no accepted samples',async()=>{
  const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL,args:cameraArgs})
  try{
    const page=await browser.newPage()
    await instrumentCamera(page);await fakeTracker(page);await openEnrollment(page);await consent(page)
    let calls=0
    await page.route('**/api/enrollment/validate',route=>{calls++;return route.fulfill({status:503,json:{code:'models_unavailable',detail:'Bộ nhận diện chưa sẵn sàng.'}})})
    await page.getByRole('button',{name:'Bắt đầu thu 5 góc',exact:true}).click()
    await page.getByRole('alert').filter({hasText:'Bộ nhận diện chưa sẵn sàng.'}).waitFor({timeout:20_000})
    assert.equal(calls,3)
    assert.equal(await page.locator('.pose-card img').count(),0)
    assert.equal(await page.locator('video').evaluate(video=>video.srcObject),null)
    assert.equal(await page.evaluate(()=>window.trackerCount===window.trackerTerminated),true)
  }finally{await browser.close()}
})

test('persistent quality rejection stops after eight selected photos and keeps save disabled',async()=>{
  const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL,args:cameraArgs})
  try{
    const page=await browser.newPage()
    await instrumentCamera(page);await fakeTracker(page);await openEnrollment(page);await consent(page)
    let calls=0
    await page.route('**/api/enrollment/validate',route=>{calls++;return route.fulfill({status:422,json:{code:'face_blurry',detail:'Ảnh chưa rõ. Kiểm tra ống kính camera.'}})})
    await page.getByRole('button',{name:'Bắt đầu thu 5 góc',exact:true}).click()
    await page.locator('.auto-capture[data-capture-state="error"]').waitFor({timeout:35_000})
    assert.equal(calls,8)
    assert.equal(await page.locator('.pose-card img').count(),0)
    assert.equal(await page.getByRole('button',{name:'Lưu nhân viên',exact:true}).isDisabled(),true)
    assert.equal(await page.locator('video').evaluate(video=>video.srcObject),null)
    assert.equal(await page.evaluate(()=>window.trackerCount===window.trackerTerminated),true)
  }finally{await browser.close()}
})
