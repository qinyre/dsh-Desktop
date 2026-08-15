import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
// 复用 sidecar 冒烟的引导逻辑拉起 sidecar（此处精简：直接 inline 同样的 spawn 步骤）
import { SidecarLogger } from '../sidecar/sidecar-logger'
import { SidecarManager } from '../sidecar/sidecar-manager'
import { resolveRuntime } from '../sidecar/runtime-resolver'

const repoRoot = join(__dirname, '..', '..', '..', '..', 'deepseek-harness')
const [tapNodeMajor, tapNodeMinor] = process.version.slice(1).split('.').map(Number)
const nodeOk = (tapNodeMajor === 22 && tapNodeMinor >= 19) || tapNodeMajor >= 24
describe.skipIf(!existsSync(join(repoRoot, 'apps', 'cli', 'src', 'bin.ts')) || !nodeOk)('event tap smoke', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'dosket-tap-'))
  afterAll(() => rmSync(logDir, { recursive: true, force: true }))

  it('both downlink sockets upgrade and survive read-only', { timeout: 120_000 }, async () => {
    const mgr = new SidecarManager({
      runtime: () => resolveRuntime({ mode: 'source', execPath: process.execPath, repoRoot, dshArgs: ['web', '--port', '0', '--host', '127.0.0.1'] }),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      logger: new SidecarLogger(logDir),
      readyTimeoutMs: 90_000,
    })
    const ready = new Promise<number>((resolve) => mgr.on('ready', resolve))
    mgr.start()
    const port = await ready
    for (const path of ['/api/events.mux', '/api/events.host']) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
      const opened = new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => resolve())
        ws.addEventListener('error', () => reject(new Error(path)))
      })
      await opened
      await new Promise((resolve) => setTimeout(resolve, 1500))
      expect(ws.readyState).toBe(WebSocket.OPEN) // 未被服务端踢掉 = 升级通过 trust fence 且未被协议违规关闭
      ws.close()
    }
    await mgr.stop()
  })
})
