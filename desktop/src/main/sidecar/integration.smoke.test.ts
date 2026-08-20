import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SidecarLogger } from './sidecar-logger'
import { SidecarManager } from './sidecar-manager'
import { resolveRuntime } from './runtime-resolver'

// sidecar smoke（设计书 §11）：真实 spawn 源码 dsh → URL 就绪 → HTTP 可达。
// 前置：deepseek-harness 已 pnpm install；系统 node ≥22.19（冒烟用系统 node 当 execPath，显式断言防误导性失败）。
const repoRoot = join(__dirname, '..', '..', '..', '..', 'deepseek-harness')
const guard = existsSync(join(repoRoot, 'apps', 'cli', 'src', 'bin.ts'))
const [smokeNodeMajor, smokeNodeMinor] = process.version.slice(1).split('.').map(Number)
const nodeOk = (smokeNodeMajor === 22 && smokeNodeMinor >= 19) || smokeNodeMajor >= 24

describe.skipIf(!guard || !nodeOk)('sidecar smoke', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'dsh-desktop-smoke-'))
  // 必须隔离 DSH_HOME：默认 ~/.dsh 里只要有一个在跑的 dsh web（task-board
  // 插件的台账单例锁），冒烟 sidecar 启动即撞锁崩死，重试到超时。
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-desktop-smoke-home-'))
  afterAll(() => {
    rmSync(logDir, { recursive: true, force: true })
    rmSync(dshHome, { recursive: true, force: true })
  })

  it('boots source-mode dsh web, reaches readiness, serves /api', { timeout: 120_000 }, async () => {
    const mgr = new SidecarManager({
      runtime: () => resolveRuntime({
        mode: 'source',
        execPath: process.execPath,
        repoRoot,
        dshArgs: ['web', '--port', '0', '--host', '127.0.0.1'],
      }),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dshHome },
      logger: new SidecarLogger(logDir),
      readyTimeoutMs: 90_000,
    })
    const ready = new Promise<number>((resolve) => mgr.on('ready', resolve))
    mgr.start()
    const port = await ready
    const res = await fetch(`http://127.0.0.1:${port}/api/host.describe`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-1', method: 'host.describe', payload: {} }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { type: string; result?: { ok: boolean } }
    expect(body.type).toBe('server-response')
    await mgr.stop()
  })
})
