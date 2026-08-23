import { describe, expect, it, vi } from 'vitest'
import { PluginRuntimeMonitor, type RuntimeInventoryEntry } from './guard-runtime'

const okResponse = (entries: unknown): Response =>
  new Response(JSON.stringify({ type: 'server-response', result: { ok: true, value: { entries } } }), { status: 200 })

const sampleEntry = (over: Partial<RuntimeInventoryEntry>): RuntimeInventoryEntry =>
  ({ entryId: 'e', moduleName: 'm', enabled: true, fiberPhase: 'active', ...over })

describe('PluginRuntimeMonitor', () => {
  it('polls the two-segment endpoint with args payload and hands entries to onInventory', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const entries = [sampleEntry({ entryId: 'a', fiberPhase: 'active' }), sampleEntry({ entryId: 'b', fiberPhase: 'failed' })]
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
      return okResponse(entries)
    }) as unknown as typeof fetch
    const received: RuntimeInventoryEntry[][] = []
    const monitor = new PluginRuntimeMonitor({ port: () => 1234, fetchImpl, onInventory: e => { received.push([...e]) } })
    await monitor.tick()
    expect(calls[0]!.url).toBe('http://127.0.0.1:1234/api/pluginInventory/list')
    expect(calls[0]!.body.method).toBe('pluginInventory/list')
    expect(calls[0]!.body.payload).toEqual({ args: {} })
    expect(received).toEqual([entries])
  })

  it('skips the tick while port is unknown', async () => {
    const fetchImpl = vi.fn()
    const monitor = new PluginRuntimeMonitor({ port: () => undefined, fetchImpl: fetchImpl as unknown as typeof fetch, onInventory: () => {} })
    await monitor.tick()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports fetch rejections and keeps polling', async () => {
    let fail = true
    const fetchImpl = (async () => {
      if (fail) throw new Error('ECONNREFUSED')
      return okResponse([])
    }) as unknown as typeof fetch
    const errors: unknown[] = []
    const received: RuntimeInventoryEntry[][] = []
    const monitor = new PluginRuntimeMonitor({ port: () => 1, fetchImpl, onInventory: e => { received.push([...e]) }, onError: e => { errors.push(e) } })
    await monitor.tick()
    expect(errors).toHaveLength(1)
    fail = false
    await monitor.tick()
    expect(errors).toHaveLength(1)
    expect(received).toEqual([[]])
  })

  it('reports non-ok HTTP and ok:false result shapes', async () => {
    const errors: unknown[] = []
    let mode: 'http' | 'okfalse' = 'http'
    const fetchImpl = (async () =>
      mode === 'http'
        ? new Response('nope', { status: 500 })
        : new Response(JSON.stringify({ result: { ok: false } }), { status: 200 })
    ) as unknown as typeof fetch
    const monitor = new PluginRuntimeMonitor({ port: () => 1, fetchImpl, onInventory: () => {}, onError: e => { errors.push(e) } })
    await monitor.tick()
    mode = 'okfalse'
    await monitor.tick()
    expect(errors).toHaveLength(2)
  })

  it('start() is idempotent and stop() halts the interval', async () => {
    vi.useFakeTimers()
    try {
      const fetchImpl = (async () => okResponse([])) as unknown as typeof fetch
      const received: number[] = []
      const monitor = new PluginRuntimeMonitor({ port: () => 1, intervalMs: 100, fetchImpl, onInventory: () => { received.push(1) } })
      monitor.start()
      monitor.start() // 双 start（托盘 restart 后 ready 再触发）不得产生双 interval
      await vi.advanceTimersByTimeAsync(250)
      monitor.stop()
      await vi.advanceTimersByTimeAsync(500)
      expect(received.length).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('onTick fires in finally semantics even when the poll itself fails', async () => {
    const fetchImpl = (async () => { throw new Error('endpoint down') }) as unknown as typeof fetch
    let ticks = 0
    const monitor = new PluginRuntimeMonitor({
      port: () => 1,
      fetchImpl,
      onInventory: () => {},
      onError: () => {},
      onTick: () => { ticks += 1 },
    })
    await monitor.tick()
    expect(ticks).toBe(1) // 端点失明时巡检通道仍每轮必走
    // onTick 自身抛错不得变成 unhandled rejection（void tick() 语义）。
    const monitor2 = new PluginRuntimeMonitor({
      port: () => 1,
      fetchImpl,
      onInventory: () => {},
      onError: () => {},
      onTick: () => { throw new Error('tick hook broke') },
    })
    await expect(monitor2.tick()).resolves.toBeUndefined()
  })
})
