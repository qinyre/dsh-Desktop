import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SidecarLogger } from './sidecar-logger'
import { SidecarManager } from './sidecar-manager'
import { resolveRuntime } from './runtime-resolver'
import { mintSidecarCookie } from './auth'

// sidecar smoke（设计书 §11）：真实 spawn 桌面捆绑的 npm dsh（node_modules 里的
// 0.1.2-alpha 树）→ URL 就绪 → 一元 RPC 可达。比 source 模式更高保真：这正是打包
// 产物的运行形态，也不依赖本地 deepseek-harness checkout 的版本。
// 前置：desktop 已 pnpm install；系统 node ≥22.19（冒烟用系统 node 当 execPath，
// 显式断言防误导性失败）。
const dshEntry = join(__dirname, '..', '..', '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const guard = existsSync(dshEntry)
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

  it('boots npm-mode dsh web, reaches readiness, serves /api', { timeout: 120_000 }, async () => {
    const mgr = new SidecarManager({
      runtime: () => resolveRuntime({
        mode: 'npm',
        execPath: process.execPath,
        repoRoot: '',
        dshArgs: ['web', '--port', '0', '--host', '127.0.0.1'],
      }),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dshHome },
      logger: new SidecarLogger(logDir),
      readyTimeoutMs: 90_000,
    })
    const ready = new Promise<number>((resolve) => mgr.on('ready', resolve))
    mgr.start()
    const port = await ready
    // 0.1.2-alpha 起 /api 全量鉴权：就绪行令牌 → 会话 cookie（auth.ts 真实链路）。
    const token = mgr.token
    expect(typeof token).toBe('string')
    const cookie = await mintSidecarCookie({ port, token: token ?? '' })
    expect(cookie).toBeDefined()
    // 一元 RPC（dsh 0.1.2-alpha 信封）：两段端点 + {args} 载荷 + server-response 响应壳。
    const res = await fetch(`http://127.0.0.1:${port}/api/pluginInventory/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) },
      body: JSON.stringify({ type: 'client-request', rpcId: 'smoke-1', method: 'pluginInventory/list', payload: { args: {} } }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { type: string; result?: { ok: boolean } }
    expect(body.type).toBe('server-response')
    expect(body.result?.ok).toBe(true)
    await mgr.stop()
  })
})
