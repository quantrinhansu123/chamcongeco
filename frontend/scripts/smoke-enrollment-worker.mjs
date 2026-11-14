// Real SDK/WASM/model via the application UI. Fake webcam has no human face;
// verifies loading, inference, CSP, cleanup and no silent enrollment.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { readFile } from 'node:fs/promises'

const base=process.env.FRONTEND_URL || 'http://127.0.0.1:5173'
const browser=await chromium.launch({channel:process.env.PLAYWRIGHT_CHANNEL,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream',...(process.env.SMOKE_CAMERA_FIXTURE?[`--use-file-for-fake-video-capture=${process.env.SMOKE_CAMERA_FIXTURE}`]:[])]})
try {
  const page=await browser.newPage({viewport:{width:1440,height:1000}})
  if (process.env.SMOKE_MOCK_API === '1') {
    // Frontend-only CI has no backend. Session/list/policy are stubbed;
    // worker/SDK/WASM/model/camera remain real. Compose runs without these stubs.
    await page.route('**/api/session', route=>route.fulfill({json:{role:'admin',authentication_required:false}}))
    await page.route('**/api/employees', route=>route.fulfill({json:[]}))
    const fixture=JSON.parse(await readFile(new URL('../../tools/face-quality-fixtures.json',import.meta.url),'utf8'))
    await page.route('**/api/enrollment/policy',route=>route.fulfill({json:fixture.policy}))
  }
  const errors=[],assets=[],workers=[],remote=[]
  let posts=0
  page.on('pageerror',error=>errors.push(error.message))
  if (process.env.SMOKE_CAMERA_FIXTURE) {
    // Optional public developer Y4M fixture; inspect the real model's one-face
    // result without pretending this is a physical five-pose camera trial.
    await page.addInitScript(()=>{
      window.workerAssessments=[]
      const NativeWorker=window.Worker
      window.Worker=class extends NativeWorker{
        constructor(...args){super(...args);this.addEventListener('message',event=>{if(event.data.type==='frame')window.workerAssessments.push(event.data.frame)})}
      }
    })
  }
  page.on('worker',worker=>workers.push(worker.url()))
  page.on('request',request=>{
    const url=new URL(request.url())
    if(url.origin!==new URL(base).origin)remote.push(request.url())
    if(request.method()==='POST'&&url.pathname==='/api/employees')posts++
  })
  page.on('response',async response=>{if(new URL(response.url()).pathname.startsWith('/vision/'))assets.push({path:new URL(response.url()).pathname,url:response.url(),status:response.status(),...(response.status()>=400?{error:(await response.text()).slice(0,1000)}:{})})})
  await page.goto(base)
  if(process.env.SMOKE_ADMIN_API_KEY){
    await page.getByLabel('Mã truy cập',{exact:true}).fill(process.env.SMOKE_ADMIN_API_KEY)
    await page.getByRole('button',{name:'Tiếp tục',exact:true}).click()
  }
  await page.getByRole('button',{name:'Đăng ký nhân viên',exact:true}).click()
  assert.equal(workers.length,0)
  assert.equal(assets.length,0,'model is not loaded on navigation')
  await page.getByLabel('Họ và tên',{exact:true}).fill('Synthetic Worker Smoke')
  await page.getByRole('checkbox').focus();await page.keyboard.press('Space')
  await page.getByRole('button',{name:'Bắt đầu thu 5 góc',exact:true}).click()
  try {
    await Promise.race([
      process.env.SMOKE_CAMERA_FIXTURE ? page.waitForFunction(()=>window.workerAssessments?.some(frame=>frame.faceCount===1&&frame.orientation),{},{timeout:60_000}) : page.getByText('Đưa khuôn mặt vào khung hướng dẫn.',{exact:true}).waitFor({timeout:60_000}),
      page.locator('.auto-capture[data-capture-state="error"]').waitFor({timeout:60_000}).then(async()=>{throw new Error(await page.locator('.auto-capture').innerText())}),
    ])
  } catch(error) {
    console.error(JSON.stringify({state:await page.locator('.auto-capture').getAttribute('data-capture-state'),hint:await page.locator('.capture-hint').innerText(),assets,errors,workers},null,2))
    throw error
  }
  assert.equal(await page.locator('.auto-capture').getAttribute('data-capture-state'),'capturing')
  if(!process.env.SMOKE_CAMERA_FIXTURE) assert.equal(await page.locator('.pose-card img').count(),0)
  else console.log('Real public-fixture assessment:',JSON.stringify(await page.evaluate(()=>window.workerAssessments.find(frame=>frame.faceCount===1&&frame.orientation))))
  assert.equal(posts,0)
  assert.equal(workers.length,1)
  assert.equal(assets.filter(asset=>asset.path.endsWith('.task')&&asset.status===200).length,1)
  assert.equal(assets.filter(asset=>asset.path.endsWith('.wasm')&&asset.status===200).length,1)
  assert.equal(remote.length,0,'all model resources are served by the app origin')
  await page.getByRole('button',{name:'Dừng thu',exact:true}).click()
  assert.equal(await page.locator('video').evaluate(video=>video.srcObject),null)
  assert.deepEqual(errors,[])
  console.log(`PASS: real Face Landmarker worker/model/WASM, lazy same-origin loading, ${process.env.SMOKE_CAMERA_FIXTURE?'public-fixture face assessment':'blank-face rejection'} and camera cleanup through UI.`)
} finally { await browser.close() }
