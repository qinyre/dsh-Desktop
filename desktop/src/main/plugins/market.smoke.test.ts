import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildSidecarEnv, resolveAppPaths } from '../app-paths'
import { ensurePnpmShim } from './pnpm-shim'
import { applyMarketConfig, marketSeeded, seedDshmarket } from './market-seed'

// market seed smoke：无系统 Node/pnpm 的干净 PATH 下，经真实 dsh CLI 预装插件市场。
// 用本地 file: 目录扮演 "dshmarket" 包（同名即可命中 bundles 收录），避免网络抖动；
// PATH 刻意只含 System32——零配置机器的等价环境。
// 前置：系统 node ≥22.19（冒烟用系统 node 充当 execPath）。
const [nodeMajor, nodeMinor] = process.version.slice(1).split('.').map(Number)
const nodeOk = (nodeMajor === 22 && nodeMinor >= 19) || nodeMajor >= 24
const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-market-'))
// 与 resolveAppPaths 的打包语义一致：DSH_HOME = userDataDir/dsh-home。
const dshHome = join(root, 'dsh-home')
const fakeMarket = join(root, 'fake-market')
beforeAll(() => {
  mkdirSync(fakeMarket, { recursive: true })
  writeFileSync(join(fakeMarket, 'package.json'), JSON.stringify({
    name: 'dshmarket', version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(fakeMarket, 'cordis.patch.yml'), 'entries: []\n')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe.skipIf(process.env.DSH_DESKTOP_PLUGIN_SMOKE !== '1' || !nodeOk || process.platform !== 'win32')('market seed smoke', () => {
  it('seeds a dshmarket package via the dsh CLI under a clean PATH, then applies the restart guard', { timeout: 180_000 }, async () => {
    const shimDir = join(root, 'bin')
    await ensurePnpmShim({
      execPath: process.execPath, shimDir,
      // pnpm@10.34.5 的 exports 墙只放行 "."（→ ./package.json）：锚点走主入口拼 bin/pnpm.cjs。
      resolvePnpmCli: (): string => join(dirname(createRequire(import.meta.url).resolve('pnpm')), 'bin', 'pnpm.cjs'),
    })
    const paths = resolveAppPaths({ packaged: true, env: {}, userDataDir: root, repoRoot: '' })
    const env = buildSidecarEnv(paths, { PATH: 'C:\\Windows\\System32' }, { shimDir })
    const lines: string[] = []
    const code = await seedDshmarket({
      mode: 'source', execPath: process.execPath,
      repoRoot: join(__dirname, '..', '..', '..', '..', 'deepseek-harness'),
      env, spec: `file:${fakeMarket}`, onOutput: (line) => lines.push(line),
    })
    if (code !== 0) console.log('--- market seed output ---\n' + lines.join('\n'))
    expect(code).toBe(0)
    expect(marketSeeded(dshHome)).toBe(true)
    applyMarketConfig(join(dshHome, 'profiles', 'web'))
    const patch = readFileSync(join(dshHome, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('allowRestart: false')
    expect(patch.match(/^- id: dsh-market$/gm)).toHaveLength(1)
  })
})
