import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { disabledEntryIds, quarantineBundles, quarantineEntries, removeQuarantine, repairCorruptLayers } from './guard-quarantine'

describe('guard-quarantine', () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-quarantine-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'h')
  const homePatch = () => join(home, 'cordis.patch.yml')

  function seedHome(): void {
    mkdirSync(home, { recursive: true })
    writeFileSync(homePatch(), '- insert:\n  - id: mcp-foo\n    name: \'@deepseek-ai/dsh-mcp-client\'\n', 'utf8')
  }

  it('appends a managed disable block without touching foreign rows, idempotently', () => {
    seedHome()
    const a = quarantineEntries({ dshHome: home, ids: ['mock-crash', 'mock-import'] })
    expect(a.written.sort()).toEqual(['mock-crash', 'mock-import'])
    const doc = parse(readFileSync(homePatch(), 'utf8'))
    expect(doc).toEqual([
      { insert: [{ id: 'mcp-foo', name: '@deepseek-ai/dsh-mcp-client' }] },
      { id: 'mock-crash', disabled: true },
      { id: 'mock-import', disabled: true },
    ])
    expect(readFileSync(homePatch(), 'utf8')).toContain('dsh-desktop plugin-guard quarantine')
    const b = quarantineEntries({ dshHome: home, ids: ['mock-crash', 'mock-pending'] })
    expect(b.written).toEqual(['mock-pending'])
    expect(disabledEntryIds({ dshHome: home })).toEqual(new Set(['mock-crash', 'mock-import', 'mock-pending']))
  })

  it('skips ids already disabled by a foreign row (no duplicate rows)', () => {
    const h5 = join(root, 'h5')
    mkdirSync(h5, { recursive: true })
    writeFileSync(join(h5, 'cordis.patch.yml'), '- id: already-off\n  disabled: true\n', 'utf8')
    const r = quarantineEntries({ dshHome: h5, ids: ['already-off', 'fresh'] })
    expect(r.written).toEqual(['fresh'])
  })

  it('creates the home layer when absent', () => {
    const h2 = join(root, 'h2')
    mkdirSync(h2, { recursive: true })
    expect(quarantineEntries({ dshHome: h2, ids: ['x'] }).written).toEqual(['x'])
    expect(parse(readFileSync(join(h2, 'cordis.patch.yml'), 'utf8'))).toEqual([{ id: 'x', disabled: true }])
    // 首写创建的层没有预守卫原状：不产生备份文件。
    expect(existsSync(join(h2, 'cordis.patch.yml') + '.plugin-guard-bak')).toBe(false)
  })

  it('backs up the home layer once per process, preserving the pre-guard original', () => {
    const h7 = join(root, 'h7')
    mkdirSync(h7, { recursive: true })
    const patch = join(h7, 'cordis.patch.yml')
    const original = '- insert:\n  - id: user-row\n    name: keep-me\n'
    writeFileSync(patch, original, 'utf8')
    quarantineEntries({ dshHome: h7, ids: ['a'] })
    expect(readFileSync(patch + '.plugin-guard-bak', 'utf8')).toBe(original)
    // 二次写入不覆盖首份备份（预守卫原状是最有价值的恢复锚点）。
    quarantineEntries({ dshHome: h7, ids: ['b'] })
    expect(readFileSync(patch + '.plugin-guard-bak', 'utf8')).toBe(original)
    // 跨进程同语义：磁盘上已有还原点时（上一会话留的），即使进程内 backedUp 是空的
    // 也不得用「当前态」（可能已含守卫行、甚至已是错坏态）覆盖首份原状。
    const patch2 = join(root, 'h7b', 'cordis.patch.yml')
    mkdirSync(join(root, 'h7b'), { recursive: true })
    writeFileSync(patch2, '- insert:\n  - id: later-state\n', 'utf8')
    writeFileSync(patch2 + '.plugin-guard-bak', original, 'utf8')
    quarantineEntries({ dshHome: join(root, 'h7b'), ids: ['c'] })
    expect(readFileSync(patch2 + '.plugin-guard-bak', 'utf8')).toBe(original)
  })

  it('refuses to write when the home layer does not parse', () => {
    const h6 = join(root, 'h6')
    mkdirSync(h6, { recursive: true })
    writeFileSync(join(h6, 'cordis.patch.yml'), '- insert: [ oops')
    expect(() => quarantineEntries({ dshHome: h6, ids: ['x'] })).toThrow()
    expect(readFileSync(join(h6, 'cordis.patch.yml'), 'utf8')).toBe('- insert: [ oops')
  })

  it('removeQuarantine strips only our block and reports removed ids', () => {
    seedHome()
    quarantineEntries({ dshHome: home, ids: ['mock-crash'] })
    const { removed } = removeQuarantine({ dshHome: home })
    expect(removed).toEqual(['mock-crash'])
    expect(parse(readFileSync(homePatch(), 'utf8'))).toEqual([{ insert: [{ id: 'mcp-foo', name: '@deepseek-ai/dsh-mcp-client' }] }])
  })

  it('quarantineBundles removes from bundles with manifest backup', () => {
    const h3 = join(root, 'h3')
    const profileDir = join(h3, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    const manifest = join(profileDir, 'package.json')
    writeFileSync(manifest, JSON.stringify({ dependencies: { a: '1', b: '1' }, dsh: { profile: { bundles: ['a', 'b'] } } }, null, 2))
    const r = quarantineBundles({ dshHome: h3, names: ['a', 'not-there'] })
    expect(r.written).toEqual(['a'])
    expect(JSON.parse(readFileSync(manifest, 'utf8')).dsh.profile.bundles).toEqual(['b'])
    const backupContent = JSON.parse(readFileSync(manifest + '.plugin-guard-bak', 'utf8'))
    expect(backupContent.dsh.profile.bundles).toEqual(['a', 'b'])
    const again = quarantineBundles({ dshHome: h3, names: ['a'] })
    expect(again.written).toEqual([])
  })

  it('repairCorruptLayers only resets cordis.patch.yml layers, with forensic backup', () => {
    const h4 = join(root, 'h4')
    mkdirSync(h4, { recursive: true })
    const bad = join(h4, 'cordis.patch.yml')
    writeFileSync(bad, '- insert: [ oops')
    const other = join(h4, 'package.json')
    writeFileSync(other, '{ nope')
    const { reset } = repairCorruptLayers({ dshHome: h4, paths: [bad, other] })
    expect(reset).toEqual([bad])
    expect(readFileSync(bad, 'utf8')).toBe('[]\n')
    // 损坏态取证进独立的 .plugin-guard-corrupt（每次覆盖）；还原点 .plugin-guard-bak
    // 与取证分名——共用后缀时 repair 一跑还原点就被损坏态覆盖，用户只能恢复出坏文件。
    expect(readFileSync(bad + '.plugin-guard-corrupt', 'utf8')).toBe('- insert: [ oops')
    expect(readFileSync(other, 'utf8')).toBe('{ nope')
    // 已可解析的层不再动
    expect(repairCorruptLayers({ dshHome: h4, paths: [bad] }).reset).toEqual([])
  })

  it('repairCorruptLayers never clobbers a pre-existing restore point', () => {
    const h8 = join(root, 'h8')
    mkdirSync(h8, { recursive: true })
    const patch = join(h8, 'cordis.patch.yml')
    const original = '- insert:\n  - id: user-row\n    name: keep-me\n'
    writeFileSync(patch + '.plugin-guard-bak', original, 'utf8') // 上一会话的还原点在场
    writeFileSync(patch, '- insert: [ torn { half-written', 'utf8')
    expect(repairCorruptLayers({ dshHome: h8, paths: [patch] }).reset).toEqual([patch])
    expect(readFileSync(patch + '.plugin-guard-bak', 'utf8')).toBe(original) // 还原点原封不动
    expect(readFileSync(patch + '.plugin-guard-corrupt', 'utf8')).toContain('torn') // 损坏态另存
  })
})
