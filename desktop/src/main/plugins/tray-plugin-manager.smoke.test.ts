import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { seedBundle } from './market-seed'
import { PluginGuard } from './plugin-guard'
import { disabledEntryIds, quarantineBundles } from './guard-quarantine'
import { PluginRuntimeMonitor, type RuntimeInventoryEntry } from './guard-runtime'
import { disableAllPlugins, enableAllPlugins, listManagedPlugins, restoreBundle, setPluginEnabled } from './tray-plugin-manager'
import { SidecarLogger } from '../sidecar/sidecar-logger'
import { SidecarManager } from '../sidecar/sidecar-manager'
import { resolveRuntime } from '../sidecar/runtime-resolver'

/**
 * 托盘插件管理冒烟：真实 `dsh plugin add` 安装好/坏两个 mock，守卫崩溃诊断隔离坏的之后，
 * 托盘核心写 home 层 + 重启，断言停用/启用/全部停用/全部启用的真实生效（boot 应用是
 * 确定性的；宿主对 home 层写入的活体应用与 dsh 自身写层存在丢失更新竞态，不作断言依据）；
 * 末段验证 bundle 级隔离件的清单可见性与恢复。
 * 前置：deepseek-harness 已 pnpm install；系统 node ≥22.19（同 plugin-guard smoke）。
 */
const repoRoot = join(__dirname, '..', '..', '..', '..', 'deepseek-harness')
const harnessReady = existsSync(join(repoRoot, 'apps', 'cli', 'src', 'bin.ts'))
const [smokeNodeMajor, smokeNodeMinor] = process.version.slice(1).split('.').map(Number)
const nodeOk = (smokeNodeMajor === 22 && smokeNodeMinor >= 19) || smokeNodeMajor >= 24

describe.skipIf(!harnessReady || !nodeOk)('tray plugin manager smoke', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'tray-pm-smoke-log-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'tray-pm-smoke-home-'))
  const mockRoot = mkdtempSync(join(tmpdir(), 'tray-pm-smoke-mocks-'))
  const logger = new SidecarLogger(logDir)
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dshHome }
  const guard = new PluginGuard({
    dshHome,
    readLog: () => { try { return readFileSync(logger.filePath, 'utf8') } catch { return '' } },
    log: () => {},
  })
  const mgr = new SidecarManager({
    runtime: () => resolveRuntime({ mode: 'source', execPath: process.execPath, repoRoot, dshArgs: ['web', '--port', '0', '--host', '127.0.0.1'] }),
    env,
    logger,
    maxRestarts: 0,
    readyTimeoutMs: 90_000,
  })
  afterAll(async () => {
    await mgr.stop()
    for (const dir of [logDir, dshHome, mockRoot]) rmSync(dir, { recursive: true, force: true })
  })

  function writeMock(name: string, indexJs: string): string {
    const dir = join(mockRoot, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name, version: '0.0.1', type: 'module', main: 'index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2))
    writeFileSync(join(dir, 'cordis.patch.yml'), `- insert:\n  - id: ${name}\n    name: ${name}\n`)
    writeFileSync(join(dir, 'index.js'), indexJs)
    return dir
  }

  const GOOD = writeMock('mock-good', 'export const name = \'mock-good\'\nexport function apply() {}\n')
  const CRASH = writeMock('mock-crash', 'export const name = \'mock-crash\'\nexport function apply() { throw new Error(\'mock-crash boom\') }\n')

  function readLogTail(): string {
    try {
      return readFileSync(logger.filePath, 'utf8').slice(-4000)
    } catch {
      return '(no log)'
    }
  }

  async function waitForState(states: SidecarManager['state'][], label: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (states.includes(mgr.state)) return
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error(`timeout waiting for sidecar state ${states.join('|')} (${label}); current=${mgr.state}; log tail:\n${readLogTail()}`)
  }

  /**
   * 轮询 pluginInventory 直到谓词命中（live watch 重组是秒级异步且无事件可等——固定 sleep
   * 断言必炸）。超时带清单末态 + sidecar 日志尾。
   */
  async function pollInventory(pred: (entries: readonly RuntimeInventoryEntry[]) => boolean, label: string, timeoutMs = 60_000): Promise<readonly RuntimeInventoryEntry[]> {
    let last: readonly RuntimeInventoryEntry[] = []
    let pollError: unknown
    const monitor = new PluginRuntimeMonitor({
      port: () => mgr.port,
      onInventory: (entries) => { last = entries },
      onError: (error) => { pollError = error },
    })
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await monitor.tick()
      if (pred(last)) return last
      await new Promise(resolve => setTimeout(resolve, 700))
    }
    throw new Error(`timeout polling inventory (${label}); last=${JSON.stringify(last)}; pollError=${String(pollError)}; log tail:\n${readLogTail()}`)
  }

  const entryOf = (entries: readonly RuntimeInventoryEntry[], id: string): RuntimeInventoryEntry | undefined =>
    entries.find(e => e.entryId === id || e.moduleName === id)

  it('tray toggles apply deterministically via restart on a real host; guard interop and bundle restore round-trip', { timeout: 420_000 }, async () => {
    // ── 阶段 1：装好/坏两个 mock；坏插件崩溃 → 守卫隔离 → 重启就绪。 ──
    const code = await seedBundle({ mode: 'source', execPath: process.execPath, repoRoot, env, specs: [GOOD, CRASH] })
    expect(code, `dsh plugin add failed; log tail:\n${readLogTail()}`).toBe(0)
    await mgr.restart() // idle 起 boot（与 plugin-guard smoke 同款入口）
    await waitForState(['failed'], 'crash boot', 150_000)
    const { quarantinedNew } = guard.considerCrash({ terminal: true })
    expect(quarantinedNew, `guard should quarantine mock-crash; log tail:\n${readLogTail()}`).toBe(true)
    expect(disabledEntryIds({ dshHome }).has('mock-crash')).toBe(true)
    await mgr.restart()
    await waitForState(['ready'], 'recovered boot', 150_000)

    // ── 阶段 2：清单与归因（守卫隔离的坏插件 + 健康插件）。 ──
    let inv = listManagedPlugins({ dshHome })
    expect(inv.plugins.map(p => p.bundle).sort()).toEqual(['mock-crash', 'mock-good'])
    expect(inv.plugins.find(p => p.bundle === 'mock-crash')).toMatchObject({ state: 'disabled', reason: 'guard' })
    expect(inv.plugins.find(p => p.bundle === 'mock-good')).toMatchObject({ state: 'enabled' })
    expect(inv.quarantined).toEqual([])

    // ── 阶段 3：托盘停用健康插件 → 重启断言生效。宿主对 home 层写入的活体应用是竞态的
    // （与 dsh 自身 boot 后写 home 层的丢失更新窗口，实测时灵时不灵），boot 应用才确定
    // ——冒烟一律重启断言，与托盘动作的生产策略（统一防抖重启）一致。 ──
    let entries = await pollInventory(e => entryOf(e, 'mock-good') !== undefined, 'initial inventory has mock-good')
    expect(entryOf(entries, 'mock-good')!.enabled).toBe(true)
    const off = setPluginEnabled({ dshHome, bundle: 'mock-good', enabled: false })
    expect(off.changed).toEqual(['mock-good'])
    await mgr.restart()
    await waitForState(['ready'], 'disable boot', 150_000)
    entries = await pollInventory(e => entryOf(e, 'mock-good')?.enabled === false, 'mock-good disabled after restart')
    inv = listManagedPlugins({ dshHome })
    expect(inv.plugins.find(p => p.bundle === 'mock-good')).toMatchObject({ state: 'disabled', reason: 'manual' })

    // ── 阶段 4：托盘启用 → 重启复活。 ──
    setPluginEnabled({ dshHome, bundle: 'mock-good', enabled: true })
    expect(disabledEntryIds({ dshHome }).has('mock-good')).toBe(false)
    await mgr.restart()
    await waitForState(['ready'], 're-enable boot', 150_000)
    entries = await pollInventory(e => entryOf(e, 'mock-good')?.enabled === true, 'mock-good re-enabled after restart')
    expect(entryOf(entries, 'mock-good')!.enabled).toBe(true)

    // ── 阶段 5：全部停用（手动安全模式口径）→ 全部启用（含守卫行）。
    // 启用全部会把守卫隔离的 mock-crash 一并复活，直接重启必复现 boot 崩溃——生产语义里
    // 这正是守卫再次接管的路；冒烟用托盘先把 mock-crash 重新停用（护住 boot）再重启，
    // 复活断言只对 mock-good（启用后只断 enabled 不断 fiberPhase）。 ──
    const all = disableAllPlugins({ dshHome })
    // mock-crash 已被守卫停用（幂等跳过）；真实宿主 home 层还有目录选择器等随机 id 的
    // 用户行（安全模式口径本就包含），故只断关键成员、不断全集。
    expect(all.written).toContain('mock-good')
    expect(all.written).not.toContain('mock-crash')
    await mgr.restart()
    await waitForState(['ready'], 'disable-all boot', 150_000)
    await pollInventory(e => entryOf(e, 'mock-good')?.enabled === false && entryOf(e, 'mock-crash')?.enabled === false, 'disable-all applied after restart')
    enableAllPlugins({ dshHome })
    expect(disabledEntryIds({ dshHome }).size).toBe(0)
    setPluginEnabled({ dshHome, bundle: 'mock-crash', enabled: false })
    await mgr.restart()
    await waitForState(['ready'], 'enable-all boot', 150_000)
    entries = await pollInventory(e => entryOf(e, 'mock-good')?.enabled === true && entryOf(e, 'mock-crash')?.enabled === false, 'enable-all applied after restart')
    expect(entryOf(entries, 'mock-good')!.enabled).toBe(true)

    // ── 阶段 6：bundle 级隔离件的清单可见性与恢复（manifest 断言，boot-only 不需重启）。 ──
    quarantineBundles({ dshHome, names: ['mock-crash'] })
    inv = listManagedPlugins({ dshHome })
    expect(inv.plugins.map(p => p.bundle)).toEqual(['mock-good'])
    expect(inv.quarantined.map(q => q.name)).toEqual(['mock-crash'])
    expect(restoreBundle({ dshHome, name: 'mock-crash' }).written).toEqual(['mock-crash'])
    expect(restoreBundle({ dshHome, name: 'mock-crash' }).written).toEqual([])
    inv = listManagedPlugins({ dshHome })
    expect(inv.quarantined).toEqual([])
    expect(inv.plugins.map(p => p.bundle).sort()).toEqual(['mock-crash', 'mock-good'])
  })
})
