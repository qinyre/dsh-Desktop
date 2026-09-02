import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { bundleSeeded, seedBundle } from './market-seed'
import { PluginGuard } from './plugin-guard'
import { disabledEntryIds } from './guard-quarantine'
import { PluginRuntimeMonitor, type RuntimeInventoryEntry } from './guard-runtime'
import { SidecarLogger } from '../sidecar/sidecar-logger'
import { SidecarManager } from '../sidecar/sidecar-manager'
import { resolveRuntime } from '../sidecar/runtime-resolver'
import { mintSidecarCookie } from '../sidecar/auth'

/**
 * plugin-guard smoke：自制 mock 插件制造四类真实故障（重复 entry id 冲突 / PENDING 依赖
 * 缺失 / apply 崩溃 / import 缺模块依赖缺失），走真实 `dsh plugin add` 安装与真实
 * `dsh web` 启动循环，验证「崩溃 → 日志诊断 → 自动隔离 → 重启后正常就绪」全链路。
 *
 * 分轮推进且每轮 boot 至多一个「硬失败」entry（import/apply 抛错）：loader 对同树
 * ≥2 个硬失败抛 AggregateError，逐条签名不进日志（group.ts:79-80），分轮是签名可诊
 * 断的前提；多个 PENDING 不受影响（走激活审计的多行块）。
 * 前置：deepseek-harness 已 pnpm install；系统 node ≥22.19（同 integration smoke）。
 */
const repoRoot = join(__dirname, '..', '..', '..', '..', 'deepseek-harness')
const harnessReady = existsSync(join(repoRoot, 'apps', 'cli', 'src', 'bin.ts'))
const [smokeNodeMajor, smokeNodeMinor] = process.version.slice(1).split('.').map(Number)
const nodeOk = (smokeNodeMajor === 22 && smokeNodeMinor >= 19) || smokeNodeMajor >= 24

describe.skipIf(!harnessReady || !nodeOk)('plugin-guard smoke', () => {
  const logDir = mkdtempSync(join(tmpdir(), 'guard-smoke-log-'))
  const dshHome = mkdtempSync(join(tmpdir(), 'guard-smoke-home-'))
  const mockRoot = mkdtempSync(join(tmpdir(), 'guard-smoke-mocks-'))
  const logger = new SidecarLogger(logDir)
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: dshHome }
  const guardLogs: string[] = []
  const guard = new PluginGuard({
    dshHome,
    // 缺失/不可读按空日志计（与 index.ts 生产口径一致：静默死亡的 boot 可能不落任何日志文件）。
    readLog: () => { try { return readFileSync(logger.filePath, 'utf8') } catch { return '' } },
    log: (line) => { guardLogs.push(line) },
  })
  const mgr = new SidecarManager({
    // maxRestarts:0：首轮 exit 直接落 failed（不自动重生），由守卫诊断驱动显式 restart，
    // 与 index.ts 接线（quarantinedNew && failed → restart）同构。
    runtime: () => resolveRuntime({ mode: 'source', execPath: process.execPath, repoRoot, dshArgs: ['web', '--port', '0', '--host', '127.0.0.1'] }),
    env,
    logger,
    maxRestarts: 0,
    readyTimeoutMs: 90_000,
  })
  afterAll(async () => {
    // 先等 sidecar 真正退出再删临时目录：Windows 下进程退出/句柄释放是异步的，
    // 立即 rmSync 会 EBUSY/EPERM 拖垮已通过的用例。
    await mgr.stop()
    for (const dir of [logDir, dshHome, mockRoot]) rmSync(dir, { recursive: true, force: true })
  })

  /** mock 包源目录：package.json + cordis.patch.yml（insert 行）+ index.js（插件本体）。 */
  function writeMock(name: string, entryId: string, indexJs: string): string {
    const dir = join(mockRoot, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name, version: '0.0.1', type: 'module', main: 'index.js',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2))
    writeFileSync(join(dir, 'cordis.patch.yml'), `- insert:\n  - id: ${entryId}\n    name: ${name}\n`)
    writeFileSync(join(dir, 'index.js'), indexJs)
    return dir
  }

    const GOOD = writeMock('mock-good', 'mock-good', 'export const name = \'mock-good\'\nexport function apply() {}\n')
    const PENDING_A = writeMock('mock-pending-a', 'mock-pending-a', 'export const name = \'mock-pending-a\'\nexport const inject = [\'no-such-service-xyz-a\']\nexport function apply() {}\n')
    const PENDING_B = writeMock('mock-pending-b', 'mock-pending-b', 'export const name = \'mock-pending-b\'\nexport const inject = [\'no-such-service-xyz-b\']\nexport function apply() {}\n')
    const DUP_A = writeMock('mock-dup-a', 'mock-dup-entry', 'export const name = \'mock-dup-a\'\nexport function apply() {}\n')
    const DUP_B = writeMock('mock-dup-b', 'mock-dup-entry', 'export const name = \'mock-dup-b\'\nexport function apply() {}\n')
    const CRASH = writeMock('mock-crash', 'mock-crash', 'export const name = \'mock-crash\'\nexport function apply() { throw new Error(\'mock-crash boom\') }\n')
    const IMPORT = writeMock('mock-import', 'mock-import', 'import \'./missing.js\'\nexport const name = \'mock-import\'\nexport function apply() {}\n')
    // 原生式静默死亡：apply 里直接 exit，无 JS 异常、无签名（模拟 napi 级崩溃/进程暴毙）。
    const NATIVE = writeMock('mock-native', 'mock-native', 'export const name = \'mock-native\'\nexport function apply() { process.exit(7) }\n')

  async function install(dirs: string[]): Promise<void> {
    const code = await seedBundle({ mode: 'source', execPath: process.execPath, repoRoot, env, specs: dirs })
    expect(code, `dsh plugin add failed (${dirs.join(', ')}); guard log tail: ${guardLogs.slice(-5).join(' | ')}`).toBe(0)
  }

  function manifestBundles(): string[] {
    const manifest = JSON.parse(readFileSync(join(dshHome, 'profiles', 'web', 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    return manifest.dsh.profile.bundles
  }

  async function waitForState(states: SidecarManager['state'][], label: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (states.includes(mgr.state)) return
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error(`timeout waiting for sidecar state ${states.join('|')} (${label}); current=${mgr.state}; log tail:\n${readLogTail()}`)
  }

  function readLogTail(): string {
    try {
      const text = readFileSync(logger.filePath, 'utf8')
      return text.slice(-4000)
    } catch {
      return '(no log)'
    }
  }

  /** 一轮「崩溃 → 守卫诊断」循环；返回本轮守卫是否执行了新隔离。 */
  async function crashRound(label: string): Promise<boolean> {
    await mgr.restart()
    // PENDING 类失败可能先打印就绪行、随后 boot 断言失败退出（冒烟实测）：ready 需稳定
    // 15s（慢机/CI 满载裕量）才认定为真就绪；期间状态翻转则继续等失败终态。
    const deadline = Date.now() + 150_000
    let settled = false
    while (Date.now() < deadline && !settled) {
      if (mgr.state === 'failed') { settled = true; break }
      if (mgr.state === 'ready') {
        const stableUntil = Date.now() + 15_000
        let stillReady = true
        while (Date.now() < stableUntil) {
          await new Promise(resolve => setTimeout(resolve, 250))
          if (mgr.state !== 'ready') { stillReady = false; break }
        }
        if (stillReady) settled = true
      }
      if (!settled) await new Promise(resolve => setTimeout(resolve, 250))
    }
    if (mgr.state === 'ready') throw new Error(`${label}: expected failure but sidecar reached ready; log tail:\n${readLogTail()}`)
    if (mgr.state !== 'failed') throw new Error(`${label}: unexpected state ${String(mgr.state)}; log tail:\n${readLogTail()}`)
    const { quarantinedNew } = guard.considerCrash({ terminal: true })
    if (quarantinedNew) await mgr.restart() // 显式拉起（同 index.ts：failed + 新隔离 → restart）
    return quarantinedNew
  }

  async function readyRound(label: string): Promise<void> {
    if (mgr.state !== 'ready') await waitForState(['ready'], `${label}: wait ready`, 120_000)
    const port = mgr.port
    expect(port, `${label}: no port after ready`).toBeDefined()
    // 0.1.2-alpha 起 /api 全量鉴权：就绪行令牌 → 会话 cookie（auth.ts 真实链路）。
    const cookie = await mintSidecarCookie({ port: port ?? 0, token: mgr.token ?? '' })
    expect(cookie, `${label}: no auth cookie`).toBeDefined()
    const res = await fetch(`http://127.0.0.1:${port}/api/pluginInventory/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(cookie === undefined ? {} : { cookie }) },
      body: JSON.stringify({ type: 'client-request', rpcId: `guard-smoke-${label}`, method: 'pluginInventory/list', payload: { args: {} } }),
    })
    expect(res.status, `${label}: /api unreachable`).toBe(200)
  }

  it('full guard cycle: conflict + pending + crash + missing-dependency, quarantined then boots ready', { timeout: 420_000 }, async () => {
    // ── 阶段 1：冲突（重复 entry id）+ 双 PENDING 依赖缺失 ─
    await install([GOOD, PENDING_A, PENDING_B, DUP_A, DUP_B])
    expect(bundleSeeded(dshHome, 'mock-good')).toBe(true)
    // 不调 preBoot：模拟「会话中途装完插件 → restart-sidecar」路径（不经过启动预检）。
    let acted = await crashRound('dup')
    expect(acted, `dup round should quarantine; log tail:\n${readLogTail()}`).toBe(true)
    expect(manifestBundles()).toContain('mock-dup-a')
    expect(manifestBundles()).not.toContain('mock-dup-b') // 后声明者被移出 bundles
    acted = await crashRound('pending')
    expect(acted, `pending round should quarantine; log tail:\n${readLogTail()}`).toBe(true)
    const disabled = disabledEntryIds({ dshHome })
    expect(disabled.has('mock-pending-a')).toBe(true)
    expect(disabled.has('mock-pending-b')).toBe(true)
    expect(disabled.has('mock-good')).toBe(false)
    await waitForState(['ready'], 'phase1: recover', 120_000)
    await readyRound('phase1')

    // ── 阶段 2：运行故障（apply 抛错）。
    // reconcile 会在安装时把 dependencies 中仍在的 mock-dup-b 写回 bundles（真实生产行为），
    // 守卫须再次移除——本轮先经过一次重复 id 复发，再捕获 apply 崩溃签名。
    await install([CRASH])
    acted = await crashRound('crash-dup-resurrect')
    if (acted) await waitForState(['failed', 'ready'], 'crash after resurrect', 120_000)
    if (mgr.state !== 'ready') {
      acted = await crashRound('crash')
      expect(acted, `crash round should quarantine; log tail:\n${readLogTail()}`).toBe(true)
    }
    expect(disabledEntryIds({ dshHome }).has('mock-crash')).toBe(true)
    await waitForState(['ready'], 'phase2: recover', 120_000)
    await readyRound('phase2')

    // ── 阶段 3：依赖缺失（import 缺模块）。
    // 从 dependencies 摘除 mock-dup-b，阻断 reconcile 复发（复发路径已在阶段 2 验证），
    // 等价于用户正式卸载，保持本轮只剩单一硬失败。
    {
      const manifestPath = join(dshHome, 'profiles', 'web', 'package.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } }
      delete manifest.dependencies['mock-dup-b']
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(n => n !== 'mock-dup-b')
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    }
    await install([IMPORT])
    acted = await crashRound('import-missing')
    expect(acted, `import round should quarantine; log tail:\n${readLogTail()}`).toBe(true)
    expect(disabledEntryIds({ dshHome }).has('mock-import')).toBe(true)
    await waitForState(['ready'], 'phase3: recover', 120_000)
    await readyRound('phase3')

    // ── 报告：三类问题全部在案，健康插件不受牵连。
    const findings = guard.findings()
    const byKey = new Map(findings.map(f => [f.key, f]))
    expect(byKey.get('entry:mock-dup-entry')!.category).toBe('conflict')
    expect(byKey.get('entry:mock-pending-a')!.category).toBe('dependency-missing')
    expect(byKey.get('entry:mock-crash')!.category).toBe('plugin-error')
    expect(byKey.get('entry:mock-import')!.category).toBe('dependency-missing')
    expect(findings.some(f => f.id === 'mock-good')).toBe(false)
    const pendingReport = guard.onReady()
    expect(pendingReport.length).toBeGreaterThan(0)
    guard.markReported()
    expect(guard.onReady()).toEqual([])

    // ── 阶段 4：重新启用（隔离行全部移除、台账清空）+ 预检不再产生新隔离。
    // 根 include entry 不得出现在隔离名单（它会把组合期错误包装成自己的失败，诊断器
    // 已特判拆包）——这里同时回归这一点。
    const { removed } = guard.reEnableAll()
    expect(removed.sort()).toEqual(['mock-crash', 'mock-import', 'mock-pending-a', 'mock-pending-b'])
    expect(parse(readFileSync(join(dshHome, 'cordis.patch.yml'), 'utf8'))).toEqual([])
    expect(guard.findings()).toEqual([])
    const disabledCountBefore = disabledEntryIds({ dshHome }).size
    guard.preBoot()
    expect(disabledEntryIds({ dshHome }).size).toBe(disabledCountBefore)
    expect(manifestBundles()).not.toContain('mock-dup-b')

    // ── 阶段 5：原生式静默崩溃（无签名）→ 安全模式兜底。
    // 阶段 4 已还原全部行；树上 6 个 mock 全部启用。mock-native 的 apply 直接 exit，
    // 日志无任何可定位签名 → 两轮空诊断 → 安全模式一次性停用全部 tracked 行。
    await install([NATIVE])
    const r5a = await crashRound('native-1')
    expect(r5a, `first native crash should find nothing; log tail:\n${readLogTail()}\nguard:\n${guardLogs.slice(-8).join('\n')}`).toBe(false)
    const r5b = await crashRound('native-2')
    expect(r5b, `second native crash should engage safe mode; log tail:\n${readLogTail()}\nguard:\n${guardLogs.slice(-8).join('\n')}`).toBe(true)
    const disabledFive = disabledEntryIds({ dshHome })
    for (const id of ['mock-good', 'mock-dup-entry', 'mock-crash', 'mock-import', 'mock-pending-a', 'mock-pending-b', 'mock-native']) {
      expect(disabledFive.has(id), `safe mode should disable ${id}`).toBe(true)
    }
    await waitForState(['ready'], 'phase5: safe-mode recover', 180_000)
    await readyRound('phase5') // 安全模式确实能打开（就绪行 + /api 200）
    expect(guard.findings().some(f => f.key === 'boot:safe-mode' && f.category === 'safe-mode')).toBe(true)

    // ── 运行期健康轮询：真实端点（pluginInventory/list 斜杠两段式）。
    let polled: RuntimeInventoryEntry[] | undefined
    let pollError: unknown
    // 0.1.2-alpha 起 /api 全量鉴权：轮询前按生产接线（index.ts authCookie）铸造 cookie。
    const monitorCookie = await mintSidecarCookie({ port: mgr.port ?? 0, token: mgr.token ?? '' })
    const monitor = new PluginRuntimeMonitor({
      port: () => mgr.port,
      authCookie: () => monitorCookie,
      onInventory: (entries) => { polled = [...entries] },
      onError: (error) => { pollError = error },
    })
    await monitor.tick()
    monitor.stop()
    expect(pollError, `runtime poll against real endpoint failed: ${String(pollError)}`).toBeUndefined()
    expect(polled!.length, 'pluginInventory/list should return entries').toBeGreaterThan(0)
    for (const entry of polled!) {
      expect(['active', 'loading', 'pending', 'unloading', null]).toContain(entry.fiberPhase) // 健康树无 failed
    }

    // ── 阶段 6：重新启用收尾（安全模式行全清）。
    const removedFive = guard.reEnableAll().removed.sort()
    expect(removedFive).toEqual(['mock-crash', 'mock-dup-entry', 'mock-good', 'mock-import', 'mock-native', 'mock-pending-a', 'mock-pending-b'])
    expect(guard.findings()).toEqual([])
  })
})
