/** Optional controls: fixed-focus/unsupported cameras must still work. */
export async function configureCamera(track: MediaStreamTrack, signal: AbortSignal): Promise<void> {
  if (!track.getCapabilities || !track.applyConstraints || signal.aborted) return
  type Controls = { focusMode?: string[]; exposureMode?: string[] }
  let capabilities: MediaTrackCapabilities & Controls
  try { capabilities = track.getCapabilities() as MediaTrackCapabilities & Controls } catch { return }
  for (const key of ['focusMode', 'exposureMode'] as const) {
    if (signal.aborted || track.readyState === 'ended') return
    if (!capabilities[key]?.includes('continuous')) continue
    // Some drivers advertise controls they reject; test separately and continue.
    let timer: ReturnType<typeof setTimeout> | undefined
    let timedOut = false
    let onAbort: () => void = () => {}
    try {
      await Promise.race([
        track.applyConstraints({ advanced: [{ [key]: 'continuous' } as MediaTrackConstraintSet] }),
        new Promise<void>(resolve => {
          timer = setTimeout(() => { timedOut = true; resolve() }, 1200)
          onAbort = resolve
          signal.addEventListener('abort', onAbort, { once: true })
          if (signal.aborted) resolve()
        }),
      ])
    } catch { /* Optional camera control; never prevent capture. */ }
    finally { clearTimeout(timer); signal.removeEventListener('abort', onAbort) }
    // Do not send another control while an unresponsive driver is still busy.
    if (timedOut) return
  }
}
