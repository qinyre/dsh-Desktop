import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { killSidecar } from './sidecar-process'

afterEach(() => { vi.useRealTimers() })

/** 假 child：记录收到的信号；SIGTERM 默认不致命（模拟优雅退不出去），exit 需手动/致命信号触发。 */
class FakeChild extends EventEmitter {
  killed = false
  signals: (string | undefined)[] = []
  kill(signal?: string): boolean {
    this.signals.push(signal)
    this.killed = true
    if (signal === undefined || signal === 'SIGKILL') this.emit('exit')
    return true
  }
}

describe('killSidecar（平台 kill 适配）', () => {
  it('win32: single hard kill (no signal)', async () => {
    const child = new FakeChild()
    const done = killSidecar(child as never, 'win32')
    await done
    expect(child.signals).toEqual([undefined])
  })
  it('posix: SIGTERM first, SIGKILL only after the 2s grace expires', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const done = killSidecar(child as never, 'linux')
    expect(child.signals).toEqual(['SIGTERM'])
    await vi.advanceTimersByTimeAsync(2_000)
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    await done
  })
  it('posix: graceful exit within the grace window avoids the SIGKILL', async () => {
    vi.useFakeTimers()
    const child = new FakeChild()
    const done = killSidecar(child as never, 'linux')
    child.emit('exit') // SIGTERM worked, no timers involved
    await done
    await vi.advanceTimersByTimeAsync(3_000)
    expect(child.signals).toEqual(['SIGTERM'])
  })
  it('already-killed child takes the SIGKILL shortcut on posix (a bare kill() is just another SIGTERM)', async () => {
    const child = new FakeChild()
    child.killed = true
    const done = killSidecar(child as never, 'linux')
    await done
    expect(child.signals).toEqual(['SIGKILL'])
  })
})
