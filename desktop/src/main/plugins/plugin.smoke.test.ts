import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PluginManager } from './plugin-manager'

// plugin smoke（设计书 §11）：无系统 Node/pnpm 的干净 PATH 下安装声明 dsh.bundle 的最小插件。
// 用本地 file: 目录模拟插件包，避免网络抖动；PATH 刻意只含 System32。
// 前置：系统 node ≥22.19（冒烟用系统 node 充当 execPath）。
const [nodeMajor, nodeMinor] = process.version.slice(1).split('.').map(Number)
const nodeOk = (nodeMajor === 22 && nodeMinor >= 19) || nodeMajor >= 24
const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-plugin-'))
const dshHome = join(root, 'home')
const fakePlugin = join(root, 'fake-plugin')
beforeAll(() => {
  mkdirSync(fakePlugin, { recursive: true })
  writeFileSync(join(fakePlugin, 'package.json'), JSON.stringify({
    name: 'dsh-desktop-fake-plugin', version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(fakePlugin, 'cordis.patch.yml'), 'entries: []\n')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe.skipIf(process.env.DSH_DESKTOP_PLUGIN_SMOKE !== '1' || !nodeOk || process.platform !== 'win32')('plugin smoke', () => {
  it('installs a bundle-declaring plugin under a clean PATH with no system node', { timeout: 180_000 }, async () => {
    const lines: string[] = []
    const manager = new PluginManager({
      mode: 'source', execPath: process.execPath, repoRoot: join(__dirname, '..', '..', '..', '..', 'deepseek-harness'),
      dshHome, sidecarEnv: { ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dshHome, PATH: 'C:\\Windows\\System32' },
      shimDir: join(root, 'bin'),
      // pnpm@10.34.5 的 exports 墙只放行 "."（→ ./package.json）：锚点走主入口拼 bin/pnpm.cjs。
      resolvePnpmCli: (): string => join(dirname(createRequire(import.meta.url).resolve('pnpm')), 'bin', 'pnpm.cjs'),
      onOutput: (line) => lines.push(line),
      restartSidecar: () => {},
    })
    const code = await manager.run(['add', `file:${fakePlugin}`])
    expect(lines.join('\n')).not.toBe('')
    if (code !== 0) console.log('--- plugin smoke output ---\n' + lines.join('\n'))
    expect(code).toBe(0)
    const manifest = JSON.parse(readFileSync(join(dshHome, 'profiles', 'web', 'package.json'), 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } }
    expect(manifest.dsh?.profile?.bundles).toContain('dsh-desktop-fake-plugin')
    expect(manager.listInstalled()).toEqual(['dsh-desktop-fake-plugin'])
    const remove = await manager.run(['remove', 'dsh-desktop-fake-plugin'])
    if (remove !== 0) console.log('--- remove output ---\n' + lines.join('\n'))
    expect(remove).toBe(0)
    expect(manager.listInstalled()).toEqual([])
    expect(existsSync(join(root, 'bin', 'pnpm.cmd'))).toBe(true)
  })
})
