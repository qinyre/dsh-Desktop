import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// 复用 sidecar 冒烟的引导逻辑拉起 sidecar（此处精简：直接 inline 同样的 spawn 步骤）
import { SidecarLogger } from '../sidecar/sidecar-logger'
import { SidecarManager } from '../sidecar/sidecar-manager'
import { resolveRuntime } from '../sidecar/runtime-resolver'
import { mintSidecarCookie } from '../sidecar/auth'

const dshEntry = join(__dirname, '..', '..', '..', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const [tapNodeMajor, tapNodeMinor] = process.version.slice(1).split('.').map(Number)
const nodeOk = (tapNodeMajor === 22 && tapNodeMinor >= 19) || tapNodeMajor >= 24
describe.skipIf(!existsSync(dshEntry) || !nodeOk)('event tap smoke', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'dsh-desktop-tap-'))
  // 必须隔离 DSH_HOME：默认 ~/.dsh 里只要有一个在跑的 dsh web（task-board
  // 插件的台账单例锁），冒烟 sidecar 启动即撞锁崩死，重试到超时。
  const dshHome = mkdtempSync(join(tmpdir(), 'dsh-desktop-tap-home-'))
  afterAll(() => {
    rmSync(logDir, { recursive: true, force: true })
    rmSync(dshHome, { recursive: true, force: true })
  })

  it('remote.mux upgrades, $events opens and yields ready, survives read-only', { timeout: 120_000 }, async () => {
    const mgr = new SidecarManager({
      runtime: () => resolveRuntime({ mode: 'npm', execPath: process.execPath, repoRoot: '', dshArgs: ['web', '--port', '0', '--host', '127.0.0.1'] }),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dshHome },
      logger: new SidecarLogger(logDir),
      readyTimeoutMs: 90_000,
    })
    const ready = new Promise<number>((resolve) => mgr.on('ready', resolve))
    mgr.start()
    const port = await ready
    // 0.1.2-alpha 起 WS 升级同受 cookie 鉴权门控（browser-auth isAuthenticated）。
    const token = mgr.token
    expect(typeof token).toBe('string')
    const cookie = await mintSidecarCookie({ port, token: token ?? '' })
    expect(cookie).toBeDefined()
    // Node WebSocket 接受 {headers} 非标第二参（undici；与主进程 EventTap 同一路线）。
    const ws = new (WebSocket as unknown as new (url: string, options?: { headers?: Record<string, string> }) => WebSocket)(
      `ws://127.0.0.1:${port}/api/remote.mux`,
      { headers: { cookie: cookie ?? '' } },
    )
    const firstItem = new Promise<unknown>((resolve, reject) => {
      ws.addEventListener('open', () => {
        ws.send(JSON.stringify({ type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } }))
      })
      ws.addEventListener('message', (event) => { resolve(JSON.parse(String(event.data))) })
      ws.addEventListener('error', () => reject(new Error('remote.mux upgrade failed')))
    })
    const frame = (await firstItem) as { type?: string; streamId?: string; value?: { type?: string; clientId?: string } }
    expect(frame.type).toBe('item')
    expect(frame.streamId).toBe('events')
    expect(frame.value?.type).toBe('ready') // $events 首帧 = 事件代绑定成功
    expect(typeof frame.value?.clientId).toBe('string')
    await new Promise((resolve) => setTimeout(resolve, 1500))
    expect(ws.readyState).toBe(WebSocket.OPEN) // 只读旁观不被踢 = 协议合规（waterfall 之外无上帧）
    ws.close()
    await mgr.stop()
  })
})
