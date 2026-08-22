import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { PluginGuard } from './plugin-guard'
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
})
