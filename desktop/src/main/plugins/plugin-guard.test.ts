import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { PluginGuard } from './plugin-guard'
import type { GuardFinding } from './guard-diagnose'
import { disabledEntryIds } from './guard-quarantine'

function writeBundle(home: string, name: string, patch: string): void {
  const dir = join(home, 'profiles', 'web', 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.1', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(dir, 'cordis.patch.yml'), patch)
}

function writeManifest(home: string, bundles: string[], dependencies: string[]): string {
  const dir = join(home, 'profiles', 'web')
  mkdirSync(dir, { recursive: true })
  const manifest = join(dir, 'package.json')
  writeFileSync(manifest, JSON.stringify({
    dependencies: Object.fromEntries(dependencies.map(d => [d, '1'])),
    dsh: { profile: { bundles } },
  }, null, 2))
  return manifest
}

function manifestBundles(manifest: string): string[] {
  return (JSON.parse(readFileSync(manifest, 'utf8')) as { dsh: { profile: { bundles: string[] } } }).dsh.profile.bundles
}

describe('PluginGuard', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-guard-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  function makeGuard(home: string, logText = ''): { guard: PluginGuard; logs: string[] } {
    const logs: string[] = []
    const guard = new PluginGuard({
      dshHome: home,
      readLog: () => logText,
      log: (line) => { logs.push(line) },
    })
    return { guard, logs }
  }

  it('preBoot resolves duplicate entry ids by removing the later tracked bundle', () => {
    const home = join(root, 'dup')
    writeBundle(home, 'p-a', '- insert:\n  - id: same\n    name: p-a\n')
    writeBundle(home, 'p-b', '- insert:\n  - id: same\n    name: p-b\n')
    const manifest = writeManifest(home, ['p-a', 'p-b'], ['p-a', 'p-b'])
    const { guard } = makeGuard(home)
    guard.preBoot()
    expect(manifestBundles(manifest)).toEqual(['p-a'])
    expect(existsSync(manifest + '.plugin-guard-bak')).toBe(true)
    const findings = guard.findings()
    const dup = findings.find(f => f.key === 'entry:same')
    expect(dup).toMatchObject({ category: 'conflict', id: 'same' })
    expect(dup!.reason).toContain('p-b')
  })

  it('preBoot quarantines a tracked bundle whose patch layer does not parse, resets a corrupt home layer', () => {
    const home = join(root, 'corrupt')
    writeBundle(home, 'p-bad', '- insert: [ oops')
    writeBundle(home, 'p-ok', '- insert:\n  - id: e-ok\n    name: p-ok\n')
    const manifest = writeManifest(home, ['p-bad', 'p-ok'], ['p-bad', 'p-ok'])
    writeFileSync(join(home, 'cordis.patch.yml'), '{ not a list')
    const { guard } = makeGuard(home)
    guard.preBoot()
    expect(manifestBundles(manifest)).toEqual(['p-ok'])
    expect(readFileSync(join(home, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
    const categories = new Map(guard.findings().map(f => [f.key, f.category]))
    expect(categories.get('bundle:p-bad')).toBe('config-corrupt')
    expect([...categories.keys()].some(k => k.startsWith('file:'))).toBe(true)
  })

  it('preBoot leaves template (untracked) bundles alone and only reports missing tracked bundles', () => {
    const home = join(root, 'tracked')
    writeBundle(home, 'p-user', '- insert:\n  - id: e-user\n    name: p-user\n')
    writeBundle(home, 'p-tpl', '- insert: [ oops')
    const manifest = writeManifest(home, ['p-user', 'p-tpl', 'p-gone'], ['p-user', 'p-gone'])
    const { guard } = makeGuard(home)
    guard.preBoot()
    // 模板 bundle 损坏不自动移除；缺件 tracked bundle 仅报告；清单不被改写。
    expect(manifestBundles(manifest)).toEqual(['p-user', 'p-tpl', 'p-gone'])
    const findings = guard.findings()
    expect(findings.some(f => f.bundle === 'p-tpl' && f.category === 'config-corrupt')).toBe(true)
    expect(findings.some(f => f.bundle === 'p-gone' && f.category === 'dependency-missing')).toBe(true)
  })

  it('considerCrash quarantines entry failures from log signatures and is idempotent', () => {
    const home = join(root, 'crash')
    writeBundle(home, 'mock-crash', '- insert:\n  - id: mock-crash\n    name: mock-crash\n')
    writeBundle(home, 'mock-pending', '- insert:\n  - id: mock-pending\n    name: mock-pending\n')
    writeBundle(home, 'mock-good', '- insert:\n  - id: mock-good\n    name: mock-good\n')
    writeManifest(home, ['mock-crash', 'mock-pending', 'mock-good'], ['mock-crash', 'mock-pending', 'mock-good'])
    const logText = [
      'dsh: failed to apply loader entry mock-crash (mock-crash): Error: boom',
      'dsh: 1 entry did not activate',
      'mock-pending: pending (waiting for service: no-such-service-xyz)',
    ].join('\n')
    const { guard } = makeGuard(home, logText)
    const first = guard.considerCrash({ terminal: false })
    expect(first.quarantinedNew).toBe(true)
    expect(disabledEntryIds({ dshHome: home })).toEqual(new Set(['mock-crash', 'mock-pending']))
    const homeRows = parse(readFileSync(join(home, 'cordis.patch.yml'), 'utf8')) as Array<{ id?: string; disabled?: boolean }>
    expect(homeRows.some(r => r.id === 'mock-good')).toBe(false)
    const second = guard.considerCrash({ terminal: true })
    expect(second.quarantinedNew).toBe(false)
    const byKey = new Map(guard.findings().map(f => [f.key, f]))
    expect(byKey.get('entry:mock-crash')!.category).toBe('plugin-error')
    expect(byKey.get('entry:mock-pending')!.category).toBe('dependency-missing')
  })

  it('considerCrash resolves a duplicate-id signature by bundle removal', () => {
    const home = join(root, 'crashdup')
    writeBundle(home, 'dup-a', '- insert:\n  - id: mock-dup-entry\n    name: dup-a\n')
    writeBundle(home, 'dup-b', '- insert:\n  - id: mock-dup-entry\n    name: dup-b\n')
    const manifest = writeManifest(home, ['dup-a', 'dup-b'], ['dup-a', 'dup-b'])
    const { guard } = makeGuard(home, 'TypeError: duplicate loader entry id: mock-dup-entry')
    const r = guard.considerCrash({ terminal: true })
    expect(r.quarantinedNew).toBe(true)
    expect(manifestBundles(manifest)).toEqual(['dup-a'])
    expect(guard.findings().some(f => f.id === 'mock-dup-entry' && f.category === 'conflict')).toBe(true)
  })

  it('considerCrash with no signatures is a no-op', () => {
    const home = join(root, 'noop')
    mkdirSync(home, { recursive: true })
    const { guard } = makeGuard(home, 'EADDRINUSE: whatever\n    at x')
    expect(guard.considerCrash({ terminal: false })).toEqual({ quarantinedNew: false })
    expect(guard.findings()).toEqual([])
  })

  it('onReady → markReported → reEnableAll lifecycle round-trips', () => {
    const home = join(root, 'cycle')
    writeBundle(home, 'mock-crash', '- insert:\n  - id: mock-crash\n    name: mock-crash\n')
    writeManifest(home, ['mock-crash'], ['mock-crash'])
    const logText = 'dsh: failed to apply loader entry mock-crash (mock-crash): Error: boom'
    const { guard } = makeGuard(home, logText)
    guard.considerCrash({ terminal: false })
    const pending = guard.onReady()
    expect(pending.map(f => f.id)).toContain('mock-crash')
    guard.markReported()
    expect(guard.onReady()).toEqual([])
    expect(guard.findings()).toHaveLength(1)
    const { removed } = guard.reEnableAll()
    expect(removed).toEqual(['mock-crash'])
    expect(parse(readFileSync(join(home, 'cordis.patch.yml'), 'utf8'))).toEqual([])
    expect(guard.findings()).toEqual([])
  })

  it('considerCrash maps a corrupt in-package patch layer to tracked bundle removal', () => {
    const home = join(root, 'pkgparse')
    writeBundle(home, 'p-bad', '- insert:\n  - id: e-bad\n    name: p-bad\n')
    writeBundle(home, 'p-ok', '- insert:\n  - id: e-ok\n    name: p-ok\n')
    const manifest = writeManifest(home, ['p-bad', 'p-ok'], ['p-bad', 'p-ok'])
    // 崩溃签名：包内 cordis.patch.yml 无法解析（真实格式：failed to parse patches <path>: ...）。
    const badPatch = join(home, 'profiles', 'web', 'node_modules', 'p-bad', 'cordis.patch.yml')
    const { guard } = makeGuard(home, `dsh: failed to parse patches ${badPatch}: YAMLParseError: bad`)
    const r = guard.considerCrash({ terminal: true })
    expect(r.quarantinedNew).toBe(true)
    expect(manifestBundles(manifest)).toEqual(['p-ok'])
    expect(guard.findings().some(f => f.bundle === 'p-bad' && f.category === 'config-corrupt')).toBe(true)
  })

  it('considerCrash does not remove untracked (template) bundles for corrupt in-package layers', () => {
    const home = join(root, 'pkgparse-tpl')
    writeBundle(home, 'tpl-bad', '- insert:\n  - id: e-tpl\n    name: tpl-bad\n')
    const manifest = writeManifest(home, ['tpl-bad'], []) // 不在 dependencies → 模板口径
    const badPatch = join(home, 'profiles', 'web', 'node_modules', 'tpl-bad', 'cordis.patch.yml')
    const { guard } = makeGuard(home, `dsh: failed to parse patches ${badPatch}: YAMLParseError: bad`)
    expect(guard.considerCrash({ terminal: true }).quarantinedNew).toBe(false)
    expect(manifestBundles(manifest)).toEqual(['tpl-bad']) // 清单不动
    expect(guard.findings().some(f => f.path === badPatch)).toBe(true) // 但有报告
  })

  it('respects the maxQuarantined budget across quarantines', () => {
    const home = join(root, 'budget')
    writeBundle(home, 'mock-crash', '- insert:\n  - id: mock-crash\n    name: mock-crash\n')
    writeBundle(home, 'mock-import', '- insert:\n  - id: mock-import\n    name: mock-import\n')
    writeManifest(home, ['mock-crash', 'mock-import'], ['mock-crash', 'mock-import'])
    const logText = [
      'dsh: failed to apply loader entry mock-crash (mock-crash): Error: boom',
      'dsh: failed to import loader entry mock-import (mock-import): Cannot find package \'./missing.js\'',
    ].join('\n')
    const logs: string[] = []
    const guard = new PluginGuard({ dshHome: home, readLog: () => logText, log: l => { logs.push(l) }, maxQuarantined: 1 })
    const r = guard.considerCrash({ terminal: true })
    expect(r.quarantinedNew).toBe(true)
    expect(disabledEntryIds({ dshHome: home }).size).toBe(1)
    // 预算耗尽后不再写隔离行，但全部 findings 仍进台账（报告不失真）。
    expect(guard.findings().map(f => f.id).sort()).toEqual(['mock-crash', 'mock-import'])
    expect(logs.some(l => l.includes('上限') || l.includes('budget'))).toBe(false) // 预算路径静默，靠台账与日志行透出
  })

  it('never throws on a corrupt manifest', () => {
    const home = join(root, 'badmanifest')
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'web', 'package.json'), '{ nope')
    const { guard, logs } = makeGuard(home)
    expect(() => guard.preBoot()).not.toThrow()
    expect(() => guard.considerCrash({ terminal: false })).not.toThrow()
    expect(logs.some(l => l.includes('config-corrupt'))).toBe(true)
  })

  it('preBoot pre-quarantines rows of tracked bundles whose entry file is missing', () => {
    const home = join(root, 'broken-entry')
    // 残缺包：声明 main 但 dist/index.js 不存在；patch 行 name 与包名一致（必炸行）。
    const dir = join(home, 'profiles', 'web', 'node_modules', 'p-broken')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'p-broken', version: '0.0.1', main: 'dist/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(dir, 'cordis.patch.yml'), '- insert:\n  - id: e-broken\n    name: p-broken\n')
    // 同 bundle patch 内 name 不同的行：不预隔离（非必然受害）。
    writeFileSync(join(dir, 'cordis.patch.yml'), '- insert:\n  - id: e-broken\n    name: p-broken\n  - id: e-bystander\n    name: some-other-module\n')
    writeBundle(home, 'p-ok', '- insert:\n  - id: e-ok\n    name: p-ok\n')
    writeManifest(home, ['p-broken', 'p-ok'], ['p-broken', 'p-ok'])
    const { guard } = makeGuard(home)
    guard.preBoot()
    const disabled = disabledEntryIds({ dshHome: home })
    expect(disabled.has('e-broken')).toBe(true)
    expect(disabled.has('e-bystander')).toBe(false)
    expect(disabled.has('e-ok')).toBe(false)
    expect(guard.findings().some(f => f.bundle === 'p-broken' && f.category === 'dependency-missing')).toBe(true)
  })

  it('safe mode engages after two unproductive empty-diagnosis crashes and stays one-shot', () => {
    const home = join(root, 'safemode')
    writeBundle(home, 'mock-good', '- insert:\n  - id: mock-good\n    name: mock-good\n')
    writeBundle(home, 'mock-bad', '- insert:\n  - id: mock-bad\n    name: mock-bad\n')
    // 模板 bundle（不在 dependencies）：安全模式绝不停用。
    writeBundle(home, 'tpl-core', '- insert:\n  - id: e-core\n    name: tpl-core\n')
    writeManifest(home, ['tpl-core', 'mock-good', 'mock-bad'], ['mock-good', 'mock-bad'])
    // 用户层行（home patch）也在停用集合内。
    writeFileSync(join(home, 'cordis.patch.yml'), '- insert:\n  - id: mcp-user\n    name: \'@deepseek-ai/dsh-mcp-client\'\n')
    const { guard } = makeGuard(home, 'Error: dsh: fatal load failure: something opaque') // 无任何已知签名
    const first = guard.considerCrash({ terminal: true })
    expect(first.quarantinedNew).toBe(false) // streak 1
    const second = guard.considerCrash({ terminal: true })
    expect(second.quarantinedNew).toBe(true) // streak 2 → 安全模式
    const disabled = disabledEntryIds({ dshHome: home })
    expect(disabled.has('mock-good')).toBe(true)
    expect(disabled.has('mock-bad')).toBe(true)
    expect(disabled.has('mcp-user')).toBe(true)
    expect(disabled.has('e-core')).toBe(false) // 模板不动
    expect(guard.findings().some(f => f.key === 'boot:safe-mode' && f.category === 'safe-mode')).toBe(true)
    // 第三次：一次性，不再动作，但记环境 finding。
    const third = guard.considerCrash({ terminal: true })
    expect(third.quarantinedNew).toBe(false)
    expect(guard.findings().some(f => f.key === 'boot:environment')).toBe(true)
    // noteBootSuccess 清连击；reEnableAll 复位安全模式与行。
    guard.noteBootSuccess()
    const { removed } = guard.reEnableAll()
    expect(removed.sort()).toEqual(['mcp-user', 'mock-bad', 'mock-good'])
    expect(guard.findings()).toEqual([])
  })

  it('does not count streak on spawn errors or actionable-only rounds', () => {
    const home = join(root, 'nostonks')
    writeBundle(home, 'mock-good', '- insert:\n  - id: mock-good\n    name: mock-good\n')
    writeManifest(home, ['mock-good'], ['mock-good'])
    // spawn 环境错误：不计（也不清零）。
    const spawnGuard = makeGuard(home, 'Error: spawn dsh ENOENT').guard
    expect(spawnGuard.considerCrash({ terminal: true }).quarantinedNew).toBe(false)
    expect(spawnGuard.considerCrash({ terminal: true }).quarantinedNew).toBe(false)
    expect(spawnGuard.findings().some(f => f.key === 'boot:safe-mode')).toBe(false)
    // 有可动作发现（bundle 缺件）的报告轮：不推进连击。
    const bundleGuard = makeGuard(home, 'Error: cannot resolve profile bundle "mock-gone" from the dsh installation or C:/p; x').guard
    for (let i = 0; i < 3; i++) expect(bundleGuard.considerCrash({ terminal: true }).quarantinedNew).toBe(false)
    expect(bundleGuard.findings().some(f => f.key === 'boot:safe-mode')).toBe(false)
  })

  it('considerRuntime quarantines user-domain failed fibers, records system fibers, and is idempotent across ticks', () => {
    const home = join(root, 'runtime')
    writeBundle(home, 'mock-crash', '- insert:\n  - id: mock-crash\n    name: mock-crash\n')
    writeManifest(home, ['mock-crash'], ['mock-crash'])
    const { guard } = makeGuard(home)
    const inventory = [
      { entryId: 'mock-crash', moduleName: 'mock-crash', enabled: true, fiberPhase: 'failed' },
      { entryId: 'mock-wait', moduleName: 'mock-wait', enabled: true, fiberPhase: 'pending' },
      { entryId: 'mock-off', moduleName: 'mock-off', enabled: false, fiberPhase: 'failed' }, // 已停用不处理
      { entryId: 'mock-ok', moduleName: 'mock-ok', enabled: true, fiberPhase: 'active' },
      // 系统级 fiber（不在层表的 tracked/用户域内）：只记录，绝不自动停用（live 层写行即时生效）。
      { entryId: 'dsh-web-app-core', moduleName: '@deepseek-ai/dsh-web-app', enabled: true, fiberPhase: 'failed' },
    ]
    guard.considerRuntime(inventory)
    guard.considerRuntime(inventory) // 重复 tick：幂等，不追加行、不重复记账
    const disabled = disabledEntryIds({ dshHome: home })
    expect(disabled.has('mock-crash')).toBe(true)
    expect(disabled.has('mock-wait')).toBe(false)
    expect(disabled.has('dsh-web-app-core')).toBe(false)
    const byKey = new Map(guard.findings().map(f => [f.key, f]))
    expect(byKey.get('runtime:mock-crash')!.category).toBe('plugin-error')
    expect(byKey.get('runtime:mock-wait')!.category).toBe('dependency-missing')
    expect(byKey.get('runtime:dsh-web-app-core')!.reason).toContain('仅记录')
    expect(byKey.has('runtime:mock-off')).toBe(false)
    expect(byKey.has('runtime:mock-ok')).toBe(false)
    expect(guard.findings().filter(f => f.key === 'runtime:mock-crash')).toHaveLength(1) // 台账按 key 合并
  })

  it('considerRuntime records a fiberless enabled entry only after two consecutive ticks', () => {
    const home = join(root, 'fiberless')
    writeBundle(home, 'mock-crash', '- insert:\n  - id: mock-crash\n    name: mock-crash\n')
    writeManifest(home, ['mock-crash'], ['mock-crash'])
    const { guard } = makeGuard(home)
    const entry = { entryId: 'mock-crash', moduleName: 'mock-crash', enabled: true, fiberPhase: null as string | null }
    guard.considerRuntime([entry]) // 首轮：可能只是加载瞬态，不记账
    expect(guard.findings()).toEqual([])
    guard.considerRuntime([entry]) // 次轮仍在：记账（只报告，不停用——行已写入则 disabled 过滤）
    expect(guard.findings().some(f => f.key === 'runtime:mock-crash' && f.reason.includes('无运行实例'))).toBe(true)
    // 恢复后连击清零；再出现要重新凑两轮。
    guard.considerRuntime([{ ...entry, fiberPhase: 'active' }])
    guard.considerRuntime([entry])
    expect(guard.findings().filter(f => f.key === 'runtime:mock-crash')).toHaveLength(1) // 合并不重复
  })

  // ── 客户端插件树（渲染器）通道：本次修复的主战场 ──────────────────────────────
  // 真实事故形态：预装 dshmarket 与后装 @linxin666/dsh-client-ui-market 都注册 locale
  // ns "dsh-market"，后装者在浏览器 apply 时抛 already has locale → 客户端 boot 卡死。
  it('considerClientConsole quarantines by module name, not the per-page random client id', () => {
    const home = join(root, 'client')
    writeBundle(home, 'dshmarket', '- insert:\n  - id: dsh-market\n    name: dshmarket\n')
    writeBundle(home, '@linxin666/dsh-client-ui-market', '- insert:\n  - id: ui-market\n    name: \'@linxin666/dsh-client-ui-market\'\n')
    writeManifest(home, ['dshmarket', '@linxin666/dsh-client-ui-market'], ['dshmarket', '@linxin666/dsh-client-ui-market'])
    const { guard } = makeGuard(home)
    const r1 = guard.considerClientConsole('failed to apply loader entry 245d29eb (@linxin666/dsh-client-ui-market): Error: locale namespace "dsh-market" already has locale "zh"')
    expect(r1).toEqual({ relevant: true, acted: true, resolvable: true })
    const disabled = disabledEntryIds({ dshHome: home })
    expect(disabled.has('ui-market')).toBe(true) // 按名反查宿主行
    expect(disabled.has('245d29eb')).toBe(false) // 绝不写客户端随机 id 的惰性行
    expect(disabled.has('dsh-market')).toBe(false) // 先注册者（预装）不受牵连
    const finding = guard.findings().find(f => f.key === 'client:@linxin666/dsh-client-ui-market')
    expect(finding).toMatchObject({ id: 'ui-market', name: '@linxin666/dsh-client-ui-market', category: 'conflict', source: 'client' })
    // reload 后复现（新随机 id、行已写）：relevant/resolvable 仍真（重试依据），acted 假、台账不膨胀。
    const r2 = guard.considerClientConsole('failed to apply loader entry 9a8b7c6d (@linxin666/dsh-client-ui-market): Error: locale namespace "dsh-market" already has locale "zh"')
    expect(r2).toEqual({ relevant: true, acted: false, resolvable: true })
    expect(guard.findings().filter(f => f.key === 'client:@linxin666/dsh-client-ui-market')).toHaveLength(1)
  })

  it('considerClientConsole reports unresolvable plugins without writing a lazy row, and gates on signatures', () => {
    const home = join(root, 'client-unresolvable')
    mkdirSync(home, { recursive: true })
    const { guard } = makeGuard(home)
    // 名字不在层表、id 也不在层表：report-only，绝不落行。
    const r = guard.considerClientConsole('failed to apply loader entry deadbeef (@nobody/ghost-market): Error: locale namespace "x" already has locale "zh"')
    expect(r).toEqual({ relevant: true, acted: false, resolvable: false })
    expect(existsSync(join(home, 'cordis.patch.yml'))).toBe(false)
    const finding = guard.findings().find(f => f.key === 'client:@nobody/ghost-market')
    expect(finding?.id).toBeUndefined()
    expect(finding?.reason).toContain('卸载后重装')
    // 无签名的普通 console 输出：门都不进。
    expect(guard.considerClientConsole('Error: something else entirely')).toEqual({ relevant: false, acted: false, resolvable: false })
    // AggregateError 多失败：message 无逐条信息，只过门不产出 finding（已知边界，钉住）。
    expect(guard.considerClientConsole('Uncaught (in promise) Error: loader fibers failed')).toEqual({ relevant: true, acted: false, resolvable: false })
  })

  it('considerClientConsole resolves the web-boot sweep block (pending entries by name)', () => {
    const home = join(root, 'client-sweep')
    writeBundle(home, 'mock-wait', '- insert:\n  - id: mock-wait\n    name: mock-wait\n')
    writeManifest(home, ['mock-wait'], ['mock-wait'])
    const { guard } = makeGuard(home)
    const text = ['web boot: 1 entry did not activate', 'mock-wait: pending (waiting for service: no-such-service-xyz)'].join('\n')
    const r = guard.considerClientConsole(text)
    // 客户端 boot 门禁要求全部 entry 激活：pending 同样把 boot 卡死在错误页，必须停用
    // （与运行期通道「pending 仅记账」刻意不同——那边宿主活着，等待可容忍）。
    expect(r).toEqual({ relevant: true, acted: true, resolvable: true })
    expect(disabledEntryIds({ dshHome: home }).has('mock-wait')).toBe(true)
    expect(guard.findings().some(f => f.key === 'client:mock-wait' && f.category === 'dependency-missing')).toBe(true)
  })

  it('considerClientConsole never disables system-domain rows: report-only, no reload loop', () => {
    const home = join(root, 'client-system')
    // 模板 bundle：在 bundles 里但不在 dependencies 里 → 行可反查到、但属系统域。
    writeBundle(home, 'sys-bundle', '- insert:\n  - id: sys-row\n    name: sys-module\n')
    writeManifest(home, ['sys-bundle'], [])
    const { guard } = makeGuard(home)
    const r = guard.considerClientConsole('failed to apply loader entry cafef00d (sys-module): Error: locale namespace "x" already has locale "zh"')
    // 解析得到宿主行但没有一条是用户域：不落行、不算可恢复（reload 必然复现，空转三轮
    // 没有意义）、只出一条系统级记录。
    expect(r).toEqual({ relevant: true, acted: false, resolvable: false })
    expect(existsSync(join(home, 'cordis.patch.yml'))).toBe(false)
    const finding = guard.findings().find(f => f.key === 'client:sys-module')
    expect(finding?.id).toBe('sys-row')
    expect(finding?.reason).toContain('仅记录未自动停用')
  })

  it('considerClientConsole disables only the user copy when a name spans system and user rows', () => {
    const home = join(root, 'client-mixed')
    // 同名两行：模板组合行在前、用户安装行在后（真实形态：用户装了系统件的用户级拷贝）。
    writeBundle(home, 'sys-bundle', '- insert:\n  - id: sys-row\n    name: shared-market\n')
    writeBundle(home, 'user-bundle', '- insert:\n  - id: user-row\n    name: shared-market\n')
    writeManifest(home, ['sys-bundle', 'user-bundle'], ['user-bundle'])
    const { guard } = makeGuard(home)
    const r = guard.considerClientConsole('failed to apply loader entry cafef00d (shared-market): Error: locale namespace "x" already has locale "zh"')
    expect(r).toEqual({ relevant: true, acted: true, resolvable: true })
    const disabled = disabledEntryIds({ dshHome: home })
    expect(disabled.has('user-row')).toBe(true) // 停用户拷贝即解除双 apply
    expect(disabled.has('sys-row')).toBe(false) // 系统组合行绝不动
  })

  // ── preBoot 同名查重（同名不同 id 的重复组合）─────────────────────────────────
  it('preBoot disables later rows of duplicate-name composition at row level, keeping bundles intact', () => {
    const home = join(root, 'dupname')
    // 聚合器 + 单装的真实形态：两包各有一行、name 相同、id 不同。
    writeBundle(home, '@linxin666/dsh-web-ui-all', '- insert:\n  - id: web-ui-market\n    name: \'@linxin666/dsh-client-ui-market\'\n')
    writeBundle(home, '@linxin666/dsh-client-ui-market', '- insert:\n  - id: ui-market\n    name: \'@linxin666/dsh-client-ui-market\'\n')
    const manifest = writeManifest(home, ['@linxin666/dsh-web-ui-all', '@linxin666/dsh-client-ui-market'], ['@linxin666/dsh-web-ui-all', '@linxin666/dsh-client-ui-market'])
    const { guard } = makeGuard(home)
    guard.preBoot()
    // 行级停用后声明者；bundle 不移出（与 id 重复的处置刻意不同）。聚合器在 bundles 序
    // 中先声明 → 其行（web-ui-market）保留生效；后声明的单装行（ui-market）被停用。
    expect(manifestBundles(manifest)).toHaveLength(2)
    const disabled = disabledEntryIds({ dshHome: home })
    expect(disabled.has('ui-market')).toBe(true) // 后声明的行
    expect(disabled.has('web-ui-market')).toBe(false)
    const finding = guard.findings().find(f => f.key === 'name:@linxin666/dsh-client-ui-market')
    expect(finding).toMatchObject({ category: 'conflict', kind: 'entry' })
    // 幂等：二轮 preBoot 不再有活行同名对，不新增隔离。
    const before = disabledEntryIds({ dshHome: home }).size
    guard.preBoot()
    expect(disabledEntryIds({ dshHome: home }).size).toBe(before)
  })

  it('preBoot duplicate-name check ignores rows already disabled by overrides and handles user-layer dups', () => {
    const home = join(root, 'dupname-override')
    writeBundle(home, 'pkg-a', '- insert:\n  - id: row-a\n    name: shared-name\n')
    writeBundle(home, 'pkg-b', '- insert:\n  - id: row-b\n    name: shared-name\n')
    writeManifest(home, ['pkg-a', 'pkg-b'], ['pkg-a', 'pkg-b'])
    // 守卫自己的历史隔离行（裸行覆盖 row-b）：不构成活行同名对，不得误报/再隔离。
    writeFileSync(join(home, 'cordis.patch.yml'), '- id: row-b\n  disabled: true\n')
    const { guard } = makeGuard(home)
    guard.preBoot()
    expect(guard.findings().some(f => f.key === 'name:shared-name')).toBe(false)
    expect(disabledEntryIds({ dshHome: home }).size).toBe(1)
    // 用户层（home）后声明的同名行同样可停用：bundle 行在前、home insert 行在后。
    const home2 = join(root, 'dupname-userlayer')
    writeBundle(home2, 'pkg-a', '- insert:\n  - id: row-a\n    name: shared-name\n')
    writeManifest(home2, ['pkg-a'], ['pkg-a'])
    writeFileSync(join(home2, 'cordis.patch.yml'), '- insert:\n  - id: row-user\n    name: shared-name\n')
    const g2 = makeGuard(home2).guard
    g2.preBoot()
    const disabled2 = disabledEntryIds({ dshHome: home2 })
    expect(disabled2.has('row-user')).toBe(true)
    expect(disabled2.has('row-a')).toBe(false)
  })

  // ── 预算死锁修复：actionable 但预算耗尽必须推进安全模式连击 ────────────────────
  it('budget exhaustion with actionable findings advances the streak into safe mode', () => {
    const home = join(root, 'budget-deadlock')
    writeBundle(home, 'mock-a', '- insert:\n  - id: mock-a\n    name: mock-a\n')
    writeBundle(home, 'mock-b', '- insert:\n  - id: mock-b\n    name: mock-b\n')
    writeBundle(home, 'mock-c', '- insert:\n  - id: mock-c\n    name: mock-c\n')
    writeManifest(home, ['mock-a', 'mock-b', 'mock-c'], ['mock-a', 'mock-b', 'mock-c'])
    const both = ['dsh: failed to apply loader entry mock-a (mock-a): Error: boom', 'dsh: failed to apply loader entry mock-b (mock-b): Error: boom'].join('\n')
    const guard = new PluginGuard({ dshHome: home, readLog: () => both, log: () => {}, maxQuarantined: 1 })
    expect(guard.considerCrash({ terminal: true }).quarantinedNew).toBe(true) // 只装得下 1 个
    expect(guard.considerCrash({ terminal: true }).quarantinedNew).toBe(false) // 预算耗尽轮：streak 1
    expect(guard.considerCrash({ terminal: true }).quarantinedNew).toBe(true) // streak 2 → 安全模式兜底
    expect(disabledEntryIds({ dshHome: home }).has('mock-c')).toBe(true) // 安全模式全量停用 tracked
  })

  it('noteBootSuccess resets the quarantine budget so later sessions can still act', () => {
    const home = join(root, 'budget-reset')
    writeBundle(home, 'mock-a', '- insert:\n  - id: mock-a\n    name: mock-a\n')
    writeBundle(home, 'mock-b', '- insert:\n  - id: mock-b\n    name: mock-b\n')
    writeManifest(home, ['mock-a', 'mock-b'], ['mock-a', 'mock-b'])
    let log = 'dsh: failed to apply loader entry mock-a (mock-a): Error: boom'
    const guard = new PluginGuard({ dshHome: home, readLog: () => log, log: () => {}, maxQuarantined: 1 })
    expect(guard.considerCrash({ terminal: true }).quarantinedNew).toBe(true)
    guard.noteBootSuccess() // boot 成功 = 循环已破，同实例预算重开
    log = 'dsh: failed to apply loader entry mock-b (mock-b): Error: boom'
    expect(guard.considerCrash({ terminal: true }).quarantinedNew).toBe(true)
    expect(disabledEntryIds({ dshHome: home }).has('mock-b')).toBe(true)
  })

  it('spawn exemption covers spawnSync forms but not bare plugin-level EACCES', () => {
    const home = join(root, 'spawn-re')
    writeBundle(home, 'mock-a', '- insert:\n  - id: mock-a\n    name: mock-a\n')
    writeManifest(home, ['mock-a'], ['mock-a'])
    // spawnSync 带 CLI 名形态：环境级，豁免（两轮不进安全模式）。
    const syncGuard = makeGuard(home, 'Error: spawnSync pnpm ENOENT').guard
    syncGuard.considerCrash({ terminal: true })
    syncGuard.considerCrash({ terminal: true })
    expect(syncGuard.findings().some(f => f.key === 'boot:safe-mode')).toBe(false)
    // 裸 EACCES（插件级文件权限错误，无其他签名）：不再被整体豁免 → 两轮进安全模式。
    const eaccesGuard = makeGuard(home, "Error: EACCES: permission denied, open 'C:/x/locked.json'").guard
    eaccesGuard.considerCrash({ terminal: true })
    eaccesGuard.considerCrash({ terminal: true })
    expect(eaccesGuard.findings().some(f => f.key === 'boot:safe-mode')).toBe(true)
  })

  // ── ready 态日志巡检（live-apply 失败兜底）────────────────────────────────────
  it('patrol records on first sight and quarantines only on the second consecutive round', () => {
    const home = join(root, 'patrol')
    writeBundle(home, 'mock-live', '- insert:\n  - id: mock-live\n    name: mock-live\n')
    writeManifest(home, ['mock-live'], ['mock-live'])
    const logText = 'dsh: warning: config reload at C:/x/cordis.patch.yml failed: Error: failed to apply loader entry mock-live (mock-live): Error: boom'
    const { guard } = makeGuard(home, logText)
    guard.patrolBegin()
    guard.patrol() // 首轮：记账不落行（半写瞬态可能自愈）
    expect(guard.findings().some(f => f.id === 'mock-live' && f.source === 'runtime')).toBe(true)
    expect(disabledEntryIds({ dshHome: home }).has('mock-live')).toBe(false)
    guard.patrol() // 次轮窗口仍在：落行
    expect(disabledEntryIds({ dshHome: home }).has('mock-live')).toBe(true)
    // patrolBegin（sidecar 新一轮 ready）清确认窗：同样的失败要重新两轮。
    const home2 = join(root, 'patrol-reset')
    writeBundle(home2, 'mock-live', '- insert:\n  - id: mock-live\n    name: mock-live\n')
    writeManifest(home2, ['mock-live'], ['mock-live'])
    const g2 = makeGuard(home2, logText).guard
    g2.patrolBegin()
    g2.patrol()
    g2.patrol()
    expect(disabledEntryIds({ dshHome: home2 }).size).toBe(1)
    g2.patrolBegin()
    const disabledBefore = disabledEntryIds({ dshHome: home2 }).size
    g2.patrol()
    expect(disabledEntryIds({ dshHome: home2 }).size).toBe(disabledBefore) // 窗口清零后不动作
  })

  // ── patrol 代际门（sidecarState 探针提供时）──────────────────────────────────
  it('patrol skips and clears its window while the sidecar is outside ready (live-restart boot window)', () => {
    const home = join(root, 'patrol-generation')
    writeBundle(home, 'mock-live', '- insert:\n  - id: mock-live\n    name: mock-live\n')
    writeManifest(home, ['mock-live'], ['mock-live'])
    const logText = 'dsh: warning: config reload at C:/x/cordis.patch.yml failed: Error: failed to apply loader entry mock-live (mock-live): Error: boom'
    let sidecarState: string | undefined = 'ready'
    const guard = new PluginGuard({ dshHome: home, readLog: () => logText, log: () => {}, sidecarState: () => sidecarState })
    guard.patrolBegin()
    guard.patrol() // ready 首轮：只记账
    expect(guard.findings().some(f => f.id === 'mock-live' && f.source === 'runtime')).toBe(true)
    // 活体重启（ready→restart→spawning）：boot 窗口内巡逻必须整体跳过并清掉确认窗——
    // 否则上一代首轮的确认残留 + boot 窗口的瞬时失败行会拼出「两轮确认」。
    sidecarState = 'spawning'
    guard.patrol()
    expect(disabledEntryIds({ dshHome: home }).size).toBe(0)
    // 新一代 ready：确认窗已清，同样的失败重新从两轮走起，本轮不动作。
    sidecarState = 'ready'
    guard.patrol()
    expect(disabledEntryIds({ dshHome: home }).size).toBe(0)
    guard.patrol() // 新一代次轮确认成立才落行
    expect(disabledEntryIds({ dshHome: home }).has('mock-live')).toBe(true)
  })

  it('onNewFindings fires once per new ledger entry and never throws out of apply', () => {
    const home = join(root, 'notify')
    writeBundle(home, 'mock-a', '- insert:\n  - id: mock-a\n    name: mock-a\n')
    writeManifest(home, ['mock-a'], ['mock-a'])
    const seen: GuardFinding[][] = []
    const guard = new PluginGuard({
      dshHome: home,
      readLog: () => 'dsh: failed to apply loader entry mock-a (mock-a): Error: boom',
      log: () => {},
      onNewFindings: (added) => { seen.push([...added]); throw new Error('notify channel down') },
    })
    guard.considerCrash({ terminal: true })
    expect(seen).toHaveLength(1)
    expect(seen[0]![0]!.id).toBe('mock-a')
    // 通知通道抛错不影响守卫主流程：同轮已写入隔离行。
    expect(disabledEntryIds({ dshHome: home }).has('mock-a')).toBe(true)
    guard.considerCrash({ terminal: true }) // 已在台账：合并，不再通知
    expect(seen).toHaveLength(1)
  })
})
