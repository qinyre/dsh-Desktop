import { PassThrough } from 'node:stream'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi, afterAll } from 'vitest'
import { SidecarManager } from './sidecar-manager'
import type { ResolvedRuntime } from './runtime-resolver'
import { SidecarLogger } from './sidecar-logger'

interface FakeChild extends EventEmitter {
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean
  kill(): boolean
}

function fakeChild(): FakeChild {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child: FakeChild = Object.assign(new EventEmitter(), {
    stdout, stderr, killed: false,
    kill: () => { child.killed = true; setImmediate(() => child.emit('exit', 1)); return true },
  })
  return child
}

const runtime: ResolvedRuntime = { command: 'fake', args: ['web', '--port', '0', '--host', '127.0.0.1'], cwd: undefined }
const logDir = mkdtempSync(join(tmpdir(), 'dosket-sm-'))

function makeManager(childRef: { current?: FakeChild }, listeners: { ready?: (p: number) => void; state?: (s: string) => void }) {
  return new SidecarManager({
    runtime: () => runtime,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    logger: new SidecarLogger(logDir),
    readyTimeoutMs: 500,
    backoffFn: () => 0, // 崩溃退避立即触发，测试不吃真实 1000/2000/4000ms
    spawnFn: ((_cmd: string, _args: string[], _opts: object) => {
      const child = fakeChild()
      childRef.current = child
      return child as never
    }) as never,
  }).on('ready', (p) => listeners.ready?.(p)).on('statechange', (s) => listeners.state?.(s)) as SidecarManager
}

describe('SidecarManager', () => {
  it('becomes ready with the parsed port', async () => {
    const ref: { current?: FakeChild } = {}
    const got: number[] = []
    const mgr = makeManager(ref, { ready: (p) => got.push(p) })
    mgr.start()
    ref.current!.stdout.write('dsh web: http://127.0.0.1:45678\n')
    await vi.waitFor(() => expect(mgr.state).toBe('ready'))
    expect(mgr.port).toBe(45678)
    expect(got).toEqual([45678])
    await mgr.stop()
  })

  it('timeout without readiness fails without restart', async () => {
    const ref: { current?: FakeChild } = {}
    const mgr = makeManager(ref, {})
    mgr.start()
    await vi.waitFor(() => expect(mgr.state).toBe('failed'))
    expect(ref.current!.killed).toBe(true)
  })

  it('unexpected exit after ready restarts and a new port wins', async () => {
    const ref: { current?: FakeChild } = {}
    const states: string[] = []
    const mgr = makeManager(ref, {})
    mgr.on('statechange', (s) => states.push(s))
    mgr.start()
    await vi.waitFor(() => expect(mgr.state).toBe('spawning'))
    ref.current!.stdout.write('dsh web: http://127.0.0.1:11111\n')
    await vi.waitFor(() => expect(mgr.state).toBe('ready'))
    ref.current!.emit('exit', 1) // 意外退出
    await vi.waitFor(() => expect(mgr.state).toBe('crashed'))
    await vi.waitFor(() => expect(mgr.state).toBe('spawning')) // 自动重启：新 child 已替换 ref.current
    ref.current!.stdout.write('dsh web: http://127.0.0.1:22222\n')
    await vi.waitFor(() => expect(mgr.port).toBe(22222))
    await mgr.stop()
    expect(states).not.toContain('failed')
  })

  it('three consecutive crash-restarts end in failed', async () => {
    const ref: { current?: FakeChild } = {}
    const mgr = makeManager(ref, {})
    mgr.start()
    // 每轮：等 spawning（新 child 就位，窗口稳定 ≥readyTimeoutMs）→ 未 ready 即崩。
    // 崩溃必须"连续"（不喂端口行——ready 会复位计数器）：三整轮重启（restarts=3）
    // 之后再崩，restarts=4 > maxRestarts=3 → 不再重启而转 failed。
    for (let round = 0; round < 4; round++) {
      await vi.waitFor(() => expect(mgr.state).toBe('spawning'))
      ref.current!.emit('exit', 1)
    }
    await vi.waitFor(() => expect(mgr.state).toBe('failed'))
  })

  it('a successful ready resets the crash counter', async () => {
    const ref: { current?: FakeChild } = {}
    // maxRestarts=1 放大差异：ready 复位实现里每次"ready 后崩溃"都 restarts=1 ≤ 1 → 重启；
    // 不复位的实现第 2 次崩溃即 restarts=2 > 1 → failed，第二轮 waitFor(spawning) 失败。
    const mgr = new SidecarManager({
      runtime: () => runtime,
      env: { ELECTRON_RUN_AS_NODE: '1' },
      logger: new SidecarLogger(logDir),
      readyTimeoutMs: 500,
      maxRestarts: 1,
      backoffFn: () => 0,
      spawnFn: ((_cmd: string, _args: string[], _opts: object) => {
        const child = fakeChild()
        ref.current = child
        return child as never
      }) as never,
    })
    mgr.start()
    for (let round = 0; round < 2; round++) {
      await vi.waitFor(() => expect(mgr.state).toBe('spawning'))
      ref.current!.stdout.write('dsh web: http://127.0.0.1:9\n')
      await vi.waitFor(() => expect(mgr.state).toBe('ready'))
      ref.current!.emit('exit', 1)
    }
    await vi.waitFor(() => expect(mgr.state).toBe('spawning')) // 仍在重启，未 failed
    ref.current!.stdout.write('dsh web: http://127.0.0.1:9\n')
    await vi.waitFor(() => expect(mgr.state).toBe('ready'))
    await mgr.stop()
  })

  it('restart() respawns with a new port without passing through failed/crashed', async () => {
    const ref: { current?: FakeChild } = {}
    const states: string[] = []
    const mgr = makeManager(ref, {})
    mgr.on('statechange', (s) => states.push(s))
    mgr.start()
    await vi.waitFor(() => expect(mgr.state).toBe('spawning'))
    ref.current!.stdout.write('dsh web: http://127.0.0.1:11111\n')
    await vi.waitFor(() => expect(mgr.state).toBe('ready'))
    const oldChild = ref.current!
    await mgr.restart() // 插件"重启生效"路径（设计书 §7）
    expect(oldChild.killed).toBe(true)
    await vi.waitFor(() => expect(mgr.state).toBe('spawning'))
    ref.current!.stdout.write('dsh web: http://127.0.0.1:33333\n')
    await vi.waitFor(() => expect(mgr.port).toBe(33333))
    expect(states).not.toContain('crashed')
    expect(states).not.toContain('failed')
    await mgr.stop()
  })
})

afterAll(() => rmSync(logDir, { recursive: true, force: true }))
