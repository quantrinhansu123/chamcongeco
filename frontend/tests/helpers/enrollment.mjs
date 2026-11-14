export const cameraArgs = ['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']
export const baseUrl = process.env.FRONTEND_URL || 'http://127.0.0.1:5173'
export const png = { name:'synthetic.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=','base64') }

export async function fakeTracker(page,{issue=null,faceCount=1,delay=10,readyDelay=0}={}) {
  const attach = () => {
    if(window.fixturePoseAttached)return
    window.fixturePoseAttached=true
    const NativeWorker=window.Worker
    window.Worker=class extends NativeWorker {
      postMessage(data,...args){
        if(data.type==='frame') data.fixturePose=[...document.querySelectorAll('.pose-card')].findIndex(card=>card.getAttribute('aria-current')==='step')
        if(data.type==='init') window.workerInitPolicy=data.policy
        return super.postMessage(data,...args)
      }
    }
  }
  await page.addInitScript(attach)
  await page.evaluate(attach)
  await page.route('**/src/enrollment/vision.worker.ts*',route=>route.fulfill({contentType:'application/javascript',body:`
    let count=0;
    self.onmessage=({data})=>{
      if(data.type==='init'){setTimeout(()=>postMessage({type:'ready',id:data.id}),${readyDelay});return;}
      data.bitmap?.close();count++;
      const phase=data.fixturePose>=0?data.fixturePose:Math.min(4,Math.floor((count-1)/9));
      const orientation=[{yaw:0,pitch:0,roll:0},{yaw:22,pitch:0,roll:0},{yaw:-22,pitch:0,roll:0},{yaw:0,pitch:-13,roll:0},{yaw:0,pitch:13,roll:0}][phase];
      setTimeout(()=>postMessage({type:'frame',id:data.id,frame:{faceCount:${faceCount},orientation,issue:${JSON.stringify(issue)},score:100+(count%5),brightness:130,sharpness:150}}),${delay});
    };`}))
}

export async function instrumentCamera(page) {
  await page.addInitScript(()=>{
    window.cameraStreams=[];window.trackerCount=0;window.trackerTerminated=0;window.workerFrames=0;window.workerPeak=0;
    const media=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia=async options=>{const stream=await media(options);window.cameraStreams.push(stream);return stream}
    const NativeWorker=window.Worker
    window.Worker=class extends NativeWorker {
      constructor(...args){super(...args);window.trackerCount++;this.addEventListener('message',event=>{if(event.data.type==='frame'||event.data.type==='error')window.workerFrames=Math.max(0,window.workerFrames-1)})}
      postMessage(data,...args){if(data.type==='frame'){window.workerFrames++;window.workerPeak=Math.max(window.workerPeak,window.workerFrames)}return super.postMessage(data,...args)}
      terminate(){window.trackerTerminated++;return super.terminate()}
    }
  })
}

export async function openEnrollment(page) {
  await page.route('**/api/session',route=>route.fulfill({json:{role:'admin',authentication_required:false}}))
  await page.route('**/api/employees',route=>route.fulfill({json:[]}))
  await page.route('**/api/enrollment/policy',route=>route.fulfill({json:policy}))
  await page.route('**/api/enrollment/validate',route=>{
    const body=route.request().postDataBuffer().toString()
    const pose=body.match(/name="pose"\r\n\r\n([a-z]+)/)?.[1]
    return route.fulfill({json:{valid:true,pose,reference_checked:body.includes('name="reference"'),quality:null}})
  })
  await page.goto(baseUrl)
  await page.getByRole('button',{name:'Đăng ký nhân viên',exact:true}).click()
}

export async function consent(page,name='Synthetic Automatic') {
  await page.getByLabel('Họ và tên',{exact:true}).fill(name)
  await page.getByRole('checkbox').focus();await page.keyboard.press('Space')
}
import { readFileSync } from 'node:fs'
export const policy = JSON.parse(readFileSync(new URL('../../../tools/face-quality-fixtures.json',import.meta.url),'utf8')).policy
