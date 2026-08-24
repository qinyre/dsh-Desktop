import { afterEach, describe, expect, it, vi } from 'vitest'
import { installQuitGrace, type QuitGraceApp } from './quit-grace'

afterEach(() => { vi.useRealTimers() })

interface FakeEvent { prevented: boolean; preventDefault(): void }
const fakeApp = (): QuitGraceApp & { events: FakeEvent[]; fire(): FakeEvent } => {
  let handler: ((event: FakeEvent) => void) | undefined
  const events: FakeEvent[] = []
  return {
    events,
    fire(): FakeEvent {
      const event: FakeEvent = { prevented: false, preventDefault() { this.prevented = true } }
      handler?.(event)
      events.push(event)
      return event
    },
    on(_event: 'will-quit', listener: (event: FakeEvent) => void) { handler = listener },
  }
}

describe('installQuitGrace（will-quit 拦截等待 sidecar 停止，超时兜底退出）', () => {
  it('prevents the quit, awaits stop, then exits with 0', async () => {
    vi.useFakeTimers()
    const app = fakeApp()
    const exit = vi.fn()
    let resolveStop: () => void = () => {}
    const stop = vi.fn(() => new Promise<void>((resolve) => { resolveStop = resolve }))
    installQuitGrace(app, { stop, exit })
    const event = app.fire()
    expect(event.prevented).toBe(true)
    expect(exit).not.toHaveBeenCalled()
    resolveStop()
    await vi.advanceTimersByTimeAsync(0)
    expect(exit).toHaveBeenCalledWith(0)
    expect(exit).toHaveBeenCalledTimes(1)
  })
  it('bails out via the timeout when stop never settles', async () => {
    vi.useFakeTimers()
    const app = fakeApp()
    const exit = vi.fn()
    const stop = vi.fn(() => new Promise<void>(() => {}))
    installQuitGrace(app, { stop, exit, timeoutMs: 3_000 })
    app.fire()
    await vi.advanceTimersByTimeAsync(2_999)
    expect(exit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(exit).toHaveBeenCalledWith(0)
  })
  it('still exits when stop rejects (logged, not thrown)', async () => {
    vi.useFakeTimers()
    const app = fakeApp()
    const exit = vi.fn()
    const log = vi.fn()
    const stop = vi.fn(() => Promise.reject(new Error('boom')))
    installQuitGrace(app, { stop, exit, log })
    app.fire()
    await vi.advanceTimersByTimeAsync(0)
    expect(exit).toHaveBeenCalledWith(0)
    expect(log).toHaveBeenCalledTimes(1)
  })
  it('latches: a second will-quit (post app.quit re-entry) passes through untouched', async () => {
    vi.useFakeTimers()
    const app = fakeApp()
    const exit = vi.fn()
    const stop = vi.fn(() => Promise.resolve())
    installQuitGrace(app, { stop, exit })
    app.fire()
    await vi.advanceTimersByTimeAsync(0)
    expect(exit).toHaveBeenCalledTimes(1)
    const second = app.fire()
    expect(second.prevented).toBe(false)
    expect(exit).toHaveBeenCalledTimes(1) // app.exit is what ended things; nothing re-runs
  })
})
