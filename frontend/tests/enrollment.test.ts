import { describe, expect, test } from 'bun:test'
import { CaptureGate, orientationFromMatrix, poseMatches } from '../src/enrollment/pose'
import { eyeAspectRatio, faceBounds, pixelQuality, qualityIssue as inspectQuality, qualityScore, validatePolicy } from '../src/enrollment/quality'
import type { Bounds } from '../src/enrollment/quality'
import { configureCamera } from '../src/enrollment/camera'
import type { FrameAssessment, Orientation, PoseId, QualityPolicy } from '../src/enrollment/types'
import golden from '../../tools/face-quality-fixtures.json'

const policy = golden.policy as QualityPolicy
const qualityIssue = (box: Bounds, brightness: number, sharpness: number, eyes: number) => inspectQuality(box, brightness, sharpness, eyes, policy)

const angle = (yaw = 0, pitch = 0, roll = 0): Orientation => ({ yaw, pitch, roll })
const frame = (orientation = angle(), changes: Partial<FrameAssessment> = {}): FrameAssessment => ({ faceCount: 1, orientation, issue: null, score: 120, sharpness: 120, brightness: 130, ...changes })
const rotation = (yaw: number, pitch: number, roll: number) => {
  const y=yaw*Math.PI/180,p=pitch*Math.PI/180,r=roll*Math.PI/180
  const cy=Math.cos(y),sy=Math.sin(y),cp=Math.cos(p),sp=Math.sin(p),cr=Math.cos(r),sr=Math.sin(r)
  return [cr*cy,sr*cy,-sy,0,cr*sy*sp-sr*cp,sr*sy*sp+cr*cp,cy*sp,0,cr*sy*cp+sr*sp,sr*sy*cp-cr*sp,cy*cp,0,1,2,-45,1]
}

describe('pose matrices and subject-relative directions', () => {
  test('decodes column-major yaw/pitch/roll including uniform scale', () => {
    for (const expected of [angle(), angle(22, -8, 5), angle(-20, 12, -7)]) {
      const matrix = rotation(expected.yaw,expected.pitch,expected.roll).map((v,i) => i < 12 ? v*1.1 : v)
      const value = orientationFromMatrix(matrix)!
      expect(value.yaw).toBeCloseTo(expected.yaw,5); expect(value.pitch).toBeCloseTo(expected.pitch,5); expect(value.roll).toBeCloseTo(expected.roll,5)
    }
    expect(orientationFromMatrix([1,2])).toBeNull()
    expect(orientationFromMatrix(Array(16).fill(0))).toBeNull()
    expect(orientationFromMatrix(Array(16).fill(NaN))).toBeNull()
  })
  test('five bins are distinct, reject extreme rotation and support neutral calibration', () => {
    const cases: [PoseId,Orientation][] = [['front',angle()],['left',angle(22)],['right',angle(-22)],['up',angle(0,-13)],['down',angle(0,13)]]
    for (const [id,value] of cases) expect(poseMatches(id,value)).toBe(true)
    expect(poseMatches('left',angle(-22))).toBe(false)
    expect(poseMatches('right',angle(22))).toBe(false)
    expect(poseMatches('left',angle(60))).toBe(false)
    expect(poseMatches('left',angle(22,0,25))).toBe(false)
    expect(poseMatches('left',angle(28,8),angle(8,8))).toBe(true)
  })
})

describe('time-based selection gate', () => {
  test('holds stable pose over time and selects best frame rather than last frame', () => {
    const gate = new CaptureGate('front')
    const results = [0,110,220,330,440,550,660,770].map((t,i)=>gate.update(frame(angle(),{score:[999,999,80,60,40,20,10,5][i]}),t))
    expect(results.map(r=>r.replaceBest)).toEqual([false,false,true,false,false,false,false,false])
    expect(results.slice(0,-1).some(r=>r.capture)).toBe(false)
    expect(results.at(-1)?.capture).toBe(true)
  })
  test('rapid frames do not replace the hold time and gaps reset it', () => {
    const gate = new CaptureGate('front')
    for(let i=0;i<20;i++) expect(gate.update(frame(),i).capture).toBe(false)
    expect(gate.update(frame(),900).reset).toBe(true)
    expect(gate.update(frame(),1000).capture).toBe(false)
  })
  test('bad image, multiple faces, missing face and angle jitter reset selection', () => {
    for(const rejected of [frame(angle(),{faceCount:0}),frame(angle(),{faceCount:2}),frame(angle(),{issue:'blurry'}),frame(angle(8))]) {
      const gate=new CaptureGate('front')
      gate.update(frame(),0);gate.update(frame(),220)
      const result=gate.update(rejected,330)
      expect(result.reset).toBe(true);expect(result.capture).toBe(false)
      expect(gate.update(frame(),550).capture).toBe(false)
    }
  })
  test('frontal repeats never complete a side pose', () => {
    const gate=new CaptureGate('left')
    for(let t=0;t<10000;t+=100) expect(gate.update(frame(),t).capture).toBe(false)
  })
})

describe('face quality', () => {
  test('dark/light, size, clipped face, blur and eyes independently stop capture', () => {
    const b={x:.3,y:.1,width:.4,height:.7}
    expect(qualityIssue(b,130,150,.25)).toBeNull()
    expect(qualityIssue(b,15,150,.25)).toBe('dark')
    expect(qualityIssue(b,240,150,.25)).toBe('bright')
    expect(qualityIssue(b,130,2,.25)).toBe('blurry')
    expect(qualityIssue(b,130,150,.05)).toBe('eyes-closed')
    expect(qualityIssue({...b,width:.1},130,150,.25)).toBe('too-small')
    expect(qualityIssue({...b,x:0},130,150,.25)).toBe('cropped')
    expect(qualityIssue({...b,width:.9},130,150,.25)).toBe('too-close')
  })
  test('normalized pixel metrics distinguish flat and textured face crops', () => {
    const flat=new Uint8ClampedArray(16*16*4).fill(120)
    expect(pixelQuality(flat,16,16).brightness).toBeCloseTo(120,3)
    expect(pixelQuality(flat,16,16).sharpness).toBe(0)
    for(let y=0;y<16;y++)for(let x=0;x<16;x++)for(let c=0;c<3;c++)flat[(y*16+x)*4+c]=(x+y)%2 ? 210 : 50
    expect(pixelQuality(flat,16,16).sharpness).toBeGreaterThan(100)
  })
  test('uses the same golden luminance/kernel as Python, including color and boundaries', () => {
    const n = golden.size
    for(const sample of golden.cases){
      const rgba=new Uint8ClampedArray(n*n*4)
      for(let y=0;y<n;y++)for(let x=0;x<n;x++){
        const value=sample.kind==='flat'?120:sample.kind==='checker'?((x+y)%2?80:40):sample.kind==='ramp'?64+x:x<n/2?80:180
        const rgb=sample.kind==='color'?[100,150,200]:[value,value,value]
        rgba.set([...rgb,255],(y*n+x)*4)
      }
      const result=pixelQuality(rgba,n,n)
      expect(result.brightness).toBeCloseTo(sample.brightness,6)
      expect(result.sharpness).toBeCloseTo(sample.sharpness,6)
    }
  })
  test('server policy overrides local thresholds and incompatible policy fails clearly', () => {
    const box={x:.3,y:.1,width:.4,height:.7}
    expect(inspectQuality(box,130,50,.25,{...policy,min_sharpness:60})).toBe('blurry')
    expect(inspectQuality(box,130,50,.25,{...policy,min_sharpness:45})).toBeNull()
    expect(()=>validatePolicy({...policy,min_sharpness:NaN})).toThrow()
    expect(()=>validatePolicy({...policy,version:'old'} as unknown as QualityPolicy)).toThrow()
    expect(()=>validatePolicy(policy)).not.toThrow()
    expect(qualityScore(130,1500)).toBeGreaterThan(qualityScore(130,1100))
    expect(qualityScore(120,100)).toBeGreaterThan(qualityScore(60,100))
  })
  test('invalid mesh is rejected and eye openness is scale-aware', () => {
    expect(faceBounds([])).toBeNull()
    const points=[{x:0,y:.5},{x:.2,y:.4},{x:.8,y:.4},{x:1,y:.5},{x:.8,y:.6},{x:.2,y:.6}]
    expect(eyeAspectRatio(points,[0,1,2,3,4,5],100,100)).toBeCloseTo(.2,3)
  })
})

describe('optional camera controls',()=>{
  test('only enables advertised continuous modes and tolerates driver rejection',async()=>{
    const changes: MediaTrackConstraints[]=[]
    const track={readyState:'live',getCapabilities:()=>({focusMode:['manual','continuous'],exposureMode:['continuous']}),
      applyConstraints:async(value:MediaTrackConstraints)=>{changes.push(value);if(changes.length===1)throw new Error('unsupported driver')}} as unknown as MediaStreamTrack
    await configureCamera(track,new AbortController().signal)
    expect(changes).toEqual([{advanced:[{focusMode:'continuous'}]},{advanced:[{exposureMode:'continuous'}]}])
  })
  test('fixed-focus devices and canceled initialization do not request unsupported controls',async()=>{
    let calls=0
    const track={readyState:'live',getCapabilities:()=>({}),applyConstraints:async()=>{calls++}} as unknown as MediaStreamTrack
    await configureCamera(track,new AbortController().signal)
    const controller=new AbortController();controller.abort()
    await configureCamera(track,controller.signal)
    expect(calls).toBe(0)
  })
  test('cancel releases a hanging driver without sending more controls',async()=>{
    let calls=0
    const controller=new AbortController()
    const track={readyState:'live',getCapabilities:()=>({focusMode:['continuous'],exposureMode:['continuous']}),
      applyConstraints:()=>{calls++;controller.abort();return new Promise<void>(()=>{})}} as unknown as MediaStreamTrack
    await configureCamera(track,controller.signal)
    expect(calls).toBe(1)
  })
})
