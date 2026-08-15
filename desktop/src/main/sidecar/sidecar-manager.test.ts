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
  /** manual 模式下放行 kill 引起的 exit，制造确定性的 kill→exit 窗口。 */
  releaseKillExit(): void
}

/** kill() 到 exit 的行为：默认立即 exit；delayMs 延迟；manual 时 kill 不发 exit，由测试放行。 */
interface KillExit {
  delayMs?: number
  manual?: boolean
}

function fakeChild(killExit: KillExit = {}): FakeChild {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const child: FakeChild = Object.assign(new EventEmitter(), {
    stdout, stderr, killed: false,
    kill: () => {
      child.killed = true
      if (!killExit.manual) setTimeout(() => { child.emit('exit', 1) }, killExit.delayMs ?? 0)
      return true
    },
    releaseKillExit: () => { child.emit('exit', 1) },
  })
  return child
}

const runtime: ResolvedRuntime = { command: 'fake', args: ['web', '--port', '0', '--host', '127.0.0.1'], cwd: undefined }
const logDir = mkdtempSync(join(tmpdir(), 'dosket-sm-'))

function makeManager(
  childRef: { current?: FakeChild },
  listeners: { ready?: (p: number) => void; state?: (s: string) => void },
  opts: { killExit?: KillExit; onSpawn?: () => void } = {},
) {
  return new SidecarManager({
    runtime: () => runtime,
    env: { ELECTRON_RUN_AS_NODE: '1' },
    logger: new SidecarLogger(logDir),
    readyTimeoutMs: 500,
    backoffFn: () => 0, // 崩溃退避立即触发，测试不吃真实 1000/2000/4000ms
    spawnFn: ((_cmd: string, _args: string[], _opts: object) => {
      const child = fakeChild(opts.killExit)
      childRef.current = child
      opts.onSpawn?.()
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

  it('three consecutive crash-restarts end in failed after exactly 4 spawns', async () => {
    const ref: { current?: FakeChild } = {}
    let spawns = 0
    const mgr = makeManager(ref, {}, { onSpawn: () => { spawns += 1 } })
    mgr.start()
    // 每轮：等 spawning（新 child 就位，窗口稳定 ≥readyTimeoutMs）→ 未 ready 即崩。
    // 崩溃必须"连续"（不喂端口行——ready 会复位计数器）：三整轮重启（restarts=3）
    // 之后再崩，restarts=4 > maxRestarts=3 → 不再重启而转 failed。
    for (let round = 0; round < 4; round++) {
      await vi.waitFor(() => expect(mgr.state).toBe('spawning'))
      ref.current!.emit('exit', 1)
    }
    await vi.waitFor(() => expect(mgr.state).toBe('failed'))
    // 钉死 spawn 数：初始 + 3 次重启 = 4。预算耗尽后不得再拉第 5 个——
    // 否则区分不了"计数耗尽转 failed"与"第 5 个 child 又超时"。
    expect(spawns).toBe(4)
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

  it('two overlapping restart() calls spawn exactly one new child and end ready', async () => {
    const ref: { current?: FakeChild } = {}
    let spawns = 0
    const mgr = makeManager(ref, {}, { onSpawn: () => { spawns += 1 } })
    mgr.start()
    await vi.waitFor(() => expect(mgr.state).toBe('spawning'))
    ref.current!.stdout.write('dsh web: http://127.0.0.1:11111\n')
    await vi.waitFor(() => expect(mgr.state).toBe('ready'))
    expect(spawns).toBe(1)
    // 重叠调用（未 await 即再次进入）必须合并为一次"杀旧+换新"：
    // 串行化下若各跑一遍，第二个续体会杀掉第一个刚拉起的 child 再拉一个 → 孤儿。
    await Promise.all([mgr.restart(), mgr.restart()])
    expect(spawns).toBe(2) // 恰好一个新 child
    await vi.waitFor(() => expect(mgr.state).toBe('spawning'))
    ref.current!.stdout.write('dsh web: http://127.0.0.1:22222\n')
    await vi.waitFor(() => expect(mgr.state).toBe('ready'))
    expect(mgr.port).toBe(22222)
    await mgr.stop()
  })

  it('restart() during the timeout-kill window never fails and ends ready on the new port', async () => {
    const ref: { current?: FakeChild } = {}
    const states: string[] = []
    const mgr = makeManager(ref, {}, { killExit: { manual: true } })
    mgr.on('statechange', (s) => states.push(s))
    mgr.start()
    const dying = ref.current!
    // 超时判死已发出 kill、exit 尚未放行：此时 restart 不得被迟到的落死覆盖成 failed
    await vi.waitFor(() => expect(dying.killed).toBe(true))
    const restartP = mgr.restart()
    dying.releaseKillExit() // 旧 child 这时才真正退出
    await restartP
    await vi.waitFor(() => expect(ref.current!).not.toBe(dying))
    ref.current!.stdout.write('dsh web: http://127.0.0.1:45699\n')
    await vi.waitFor(() => expect(mgr.state).toBe('ready'))
    expect(mgr.port).toBe(45699)
    expect(states).not.toContain('failed')
    // manual killExit 对新 child 同样生效：stop 的 kill 需手动放行 exit
    const stopP = mgr.stop()
    ref.current!.releaseKillExit()
    await stopP
  })

  it('stop() during the timeout-kill window ends idle and stays idle', async () => {
    const ref: { current?: FakeChild } = {}
    const states: string[] = []
    const mgr = makeManager(ref, {}, { killExit: { manual: true } })
    mgr.on('statechange', (s) => states.push(s))
    mgr.start()
    const dying = ref.current!
    await vi.waitFor(() => expect(dying.killed).toBe(true)) // 落死窗口内进入 stop
    const stopP = mgr.stop()
    dying.releaseKillExit()
    await stopP
    expect(mgr.state).toBe('idle')
    // 停止是终局：等过原超时窗口，迟到的 failed 翻转不得出现
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(mgr.state).toBe('idle')
    expect(states).not.toContain('failed')
  })

  it('late readiness line from a timed-out child emits no ready event and ends failed', async () => {
    const ref: { current?: FakeChild } = {}
    const got: number[] = []
    const mgr = makeManager(ref, { ready: (p) => got.push(p) }, { killExit: { manual: true } })
    mgr.start()
    const dying = ref.current!
    await vi.waitFor(() => expect(dying.killed).toBe(true)) // 已判死、未 exit
    dying.stdout.write('dsh web: http://127.0.0.1:9999\n') // 垂死 child 迟到的 ready 行
    // 行已处理完（此刻 state 仍 spawning、轮次未变——只有判死标记拦它），
    // 不得闪现"已连上"再转 failed 的公共 ready 事件
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(mgr.state).toBe('spawning')
    expect(got).toEqual([])
    dying.releaseKillExit()
    await vi.waitFor(() => expect(mgr.state).toBe('failed'))
    expect(got).toEqual([])
    expect(mgr.port).toBeUndefined()
  })
})

afterAll(() => rmSync(logDir, { recursive: true, force: true }))
