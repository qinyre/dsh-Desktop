import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { userDomainRowIds, readLayerTable } from './patch-layers'
import { disabledEntryIds, quarantineBundles, quarantineEntries, removeQuarantine } from './guard-quarantine'
import {
  buildPluginSection,
  disableAllPlugins,
  enableAllPlugins,
  listManagedPlugins,
  restoreBundle,
  setPluginEnabled,
  TRAY_DISABLE_MARKER,
  type ManagedInventory,
  type PluginSectionActions,
} from './tray-plugin-manager'

/**
 * 托盘插件管理单测：夹具模拟 DSH_HOME（manifest + node_modules 内 bundle patch 层 +
 * home/profile 用户层），验证清单/归因/启停/安全模式口径/恢复与菜单模板。
 * 跨模块互操作（守卫行 vs 托盘行）是重点：guard 的 reEnableAll 不得复活托盘手动停用。
 */
describe('tray-plugin-manager', () => {
  const root = mkdtempSync(join(tmpdir(), 'tray-pm-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  interface BundleSpec {
    name: string
    entries: Array<{ id: string; name?: string; disabled?: boolean }>
    version?: string
    /** 不声明 dsh.bundle（普通依赖库形态）。 */
    plain?: boolean
  }

  function seedHome(label: string, bundles: BundleSpec[], opts: { manifestBundles?: string[]; dependencies?: string[]; homeRows?: string[]; profileRows?: string[] } = {}): string {
    const home = join(root, label)
    const profileDir = join(home, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    const manifestBundles = opts.manifestBundles ?? bundles.filter(b => !b.plain).map(b => b.name)
    const dependencies = opts.dependencies ?? bundles.map(b => b.name)
    for (const bundle of bundles) {
      const dir = join(profileDir, 'node_modules', bundle.name)
      mkdirSync(dir, { recursive: true })
      // 不声明 main/exports：夹具不写 JS 入口文件，声明了会被 patch-layers 判成半安装残骸。
      writeFileSync(join(dir, 'package.json'), JSON.stringify({
        name: bundle.name, version: bundle.version ?? '0.1.0',
        ...(!bundle.plain ? { dsh: { bundle: { patch: './cordis.patch.yml' } } } : {}),
      }, null, 2))
      if (!bundle.plain) {
        writeFileSync(join(dir, 'cordis.patch.yml'), bundle.entries.length === 0
          ? '[]\n'
          : `- insert:\n${bundle.entries.map(e => `  - id: ${e.id}\n    name: ${e.name ?? e.id}${e.disabled === true ? '\n    disabled: true' : ''}`).join('\n')}\n`)
      }
    }
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      dependencies: Object.fromEntries(dependencies.map(name => [name, '0.0.0'])),
      dsh: { profile: { bundles: manifestBundles } },
    }, null, 2))
    if (opts.profileRows !== undefined) writeFileSync(join(profileDir, 'cordis.patch.yml'), opts.profileRows.join('\n'), 'utf8')
    if (opts.homeRows !== undefined) writeFileSync(join(home, 'cordis.patch.yml'), opts.homeRows.join('\n'), 'utf8')
    return home
  }

  it('lists tracked plugins with state, version and empty quarantined group (plain libs filtered)', () => {
    const home = seedHome('list', [
      { name: 'mock-a', entries: [{ id: 'mock-a' }] },
      { name: 'mock-b', entries: [{ id: 'mock-b1', name: 'mock-b' }, { id: 'mock-b2', name: 'mock-b' }], version: '2.3.4' },
      { name: 'plain-lib', entries: [], plain: true },
    ])
    const inv = listManagedPlugins({ dshHome: home })
    expect(inv.plugins.map(p => p.bundle)).toEqual(['mock-a', 'mock-b'])
    expect(inv.plugins.map(p => p.state)).toEqual(['enabled', 'enabled'])
    expect(inv.plugins.find(p => p.bundle === 'mock-b')?.version).toBe('2.3.4')
    expect(inv.plugins.every(p => !p.broken && !p.nativeDisabledOnly)).toBe(true)
    // plain-lib 在 dependencies 但不是插件形态（无 dsh.bundle、无默认 patch 文件）→ 不入移出清单组。
    expect(inv.quarantined).toEqual([])
  })

  it('disable/enable round-trip: writes TRAY rows, clears guard/tray/webui rows, never touches inserts', () => {
    const home = seedHome('roundtrip', [
      { name: 'mock-a', entries: [{ id: 'mock-a' }] },
      { name: 'mock-b', entries: [{ id: 'mock-b1', name: 'mock-b' }, { id: 'mock-b2', name: 'mock-b' }] },
    ], {
      // profile 用户层：dsh-plugin-install 形状的停用行（mock-b1）+ 带 config 的 MCP 行（不得误删）。
      profileRows: [
        '- id: mock-b1',
        '  name: mock-b',
        '  disabled: true',
        '- id: mcp-server-foo',
        '  name: \'mcp-server\'',
        '  config:',
        '    command: node',
        '  disabled: true',
      ],
    })
    // 停用 mock-a：home 层写 TRAY 行，insert 行与 profile 层一律不动。
    const off = setPluginEnabled({ dshHome: home, bundle: 'mock-a', enabled: false })
    expect(off.changed).toEqual(['mock-a'])
    const homeDoc = parse(readFileSync(join(home, 'cordis.patch.yml'), 'utf8'))
    expect(homeDoc).toEqual([{ id: 'mock-a', disabled: true }])
    expect(readFileSync(join(home, 'cordis.patch.yml'), 'utf8')).toContain(TRAY_DISABLE_MARKER)
    const profileText = readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    expect(profileText).toContain('mcp-server-foo')
    // 状态与归因。
    let inv = listManagedPlugins({ dshHome: home })
    expect(inv.plugins.find(p => p.bundle === 'mock-a')).toMatchObject({ state: 'disabled', reason: 'manual' })
    // mock-b1 被页面内停用行覆盖 → mixed，归因 webui。
    expect(inv.plugins.find(p => p.bundle === 'mock-b')).toMatchObject({ state: 'mixed', reason: 'webui' })
    // 启用 mock-b：清 profile 层 {id,name,disabled} 行，MCP 行幸存。
    const on = setPluginEnabled({ dshHome: home, bundle: 'mock-b', enabled: true })
    expect(on.changed.sort()).toEqual(['mock-b1'])
    inv = listManagedPlugins({ dshHome: home })
    expect(inv.plugins.find(p => p.bundle === 'mock-b')?.state).toBe('enabled')
    expect(readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')).toContain('mcp-server-foo')
    // 启用 mock-a：清 TRAY 行。
    setPluginEnabled({ dshHome: home, bundle: 'mock-a', enabled: true })
    expect(parse(readFileSync(join(home, 'cordis.patch.yml'), 'utf8'))).toEqual([])
    expect(listManagedPlugins({ dshHome: home }).plugins.every(p => p.state === 'enabled')).toBe(true)
  })

  it('guard quarantine rows attribute as guard; guard reEnableAll leaves tray rows alone (marker isolation)', () => {
    const home = seedHome('guard-attr', [
      { name: 'mock-a', entries: [{ id: 'mock-a' }] },
      { name: 'mock-b', entries: [{ id: 'mock-b' }] },
    ])
    quarantineEntries({ dshHome: home, ids: ['mock-a'] })
    setPluginEnabled({ dshHome: home, bundle: 'mock-b', enabled: false })
    expect(listManagedPlugins({ dshHome: home }).plugins.find(p => p.bundle === 'mock-a')).toMatchObject({ state: 'disabled', reason: 'guard' })
    // 守卫侧「重新启用全部」（报告弹窗按钮）：只清守卫行，托盘手动停用不得被复活。
    const { removed } = removeQuarantine({ dshHome: home })
    expect(removed).toEqual(['mock-a'])
    const doc = parse(readFileSync(join(home, 'cordis.patch.yml'), 'utf8'))
    expect(doc).toEqual([{ id: 'mock-b', disabled: true }])
    expect(readFileSync(join(home, 'cordis.patch.yml'), 'utf8')).toContain(TRAY_DISABLE_MARKER)
    const inv = listManagedPlugins({ dshHome: home })
    expect(inv.plugins.find(p => p.bundle === 'mock-a')?.state).toBe('enabled')
    expect(inv.plugins.find(p => p.bundle === 'mock-b')).toMatchObject({ state: 'disabled', reason: 'manual' })
    // 托盘启用：清该插件一切停用行（含守卫行——守卫停用 mock-a 后托盘启用也应生效）。
    setPluginEnabled({ dshHome: home, bundle: 'mock-b', enabled: true })
    expect(parse(readFileSync(join(home, 'cordis.patch.yml'), 'utf8'))).toEqual([])
  })

  it('bundle-native disabled rows show as nativeDisabledOnly (not tray-actionable)', () => {
    const home = seedHome('native', [{ name: 'mock-n', entries: [{ id: 'mock-n', disabled: true }] }])
    const plugin = listManagedPlugins({ dshHome: home }).plugins[0]!
    expect(plugin.state).toBe('disabled')
    expect(plugin.nativeDisabledOnly).toBe(true)
    expect(plugin.reason).toBeUndefined()
  })

  it('disableAllPlugins matches the guard safe-mode scope (user domain, system rows untouched)', () => {
    const home = seedHome('safe-mode', [
      { name: 'mock-a', entries: [{ id: 'mock-a' }] },
      { name: 'mock-b', entries: [{ id: 'mock-b1', name: 'mock-b' }, { id: 'mock-b2', name: 'mock-b' }] },
      { name: 'dsh-base', entries: [{ id: 'dsh-base' }] }, // 模板 bundle：在 bundles 不在 dependencies
    ], { manifestBundles: ['dsh-base', 'mock-a', 'mock-b'], dependencies: ['mock-a', 'mock-b'] })
    // home 用户层一条 insert 行（dsh 核心 MCP 形态）→ 用户域，安全模式口径包含它。
    writeFileSync(join(home, 'cordis.patch.yml'), '- insert:\n  - id: mcp-user-row\n    name: keep\n', 'utf8')
    const { written } = disableAllPlugins({ dshHome: home })
    // 与守卫安全模式的公共口径函数逐 id 等价（此处全部行未停用，无需再排除）。
    expect(written.sort()).toEqual(userDomainRowIds(readLayerTable({ dshHome: home })).sort())
    expect(written.sort()).toEqual(['mcp-user-row', 'mock-a', 'mock-b1', 'mock-b2'])
    const disabled = disabledEntryIds({ dshHome: home })
    const inv = listManagedPlugins({ dshHome: home })
    expect(inv.plugins.find(p => p.bundle === 'mock-a')?.state).toBe('disabled')
    expect(inv.plugins.find(p => p.bundle === 'mock-b')?.state).toBe('disabled')
    // dsh-base 不在清单里（untracked 模板件不出现在托盘插件列表）。
    expect(inv.plugins.find(p => p.bundle === 'dsh-base')).toBeUndefined()
    expect(disabled.has('dsh-base')).toBe(false)
  })

  it('enableAllPlugins clears all three sources across both layers', () => {
    const home = seedHome('enable-all', [
      { name: 'mock-a', entries: [{ id: 'mock-a' }] },
      { name: 'mock-b', entries: [{ id: 'mock-b' }] },
    ], {
      profileRows: ['- id: mock-b', '  name: mock-b', '  disabled: true'],
    })
    // 三来源齐备：守卫行（mock-a）+ 页面内行（mock-b，profile 层）+ 托盘行（mock-b，home 层）。
    quarantineEntries({ dshHome: home, ids: ['mock-a'] })
    setPluginEnabled({ dshHome: home, bundle: 'mock-b', enabled: false })
    const { removed } = enableAllPlugins({ dshHome: home })
    expect(removed.sort()).toEqual(['mock-a', 'mock-b', 'mock-b'])
    expect(parse(readFileSync(join(home, 'cordis.patch.yml'), 'utf8'))).toEqual([])
    expect(readFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
    expect(listManagedPlugins({ dshHome: home }).plugins.every(p => p.state === 'enabled')).toBe(true)
  })

  it('bundle-level quarantine surfaces in the quarantined group and restoreBundle round-trips', () => {
    const home = seedHome('bundle-q', [
      { name: 'mock-a', entries: [{ id: 'mock-a' }] },
      { name: 'mock-b', entries: [{ id: 'mock-b' }] },
    ])
    quarantineBundles({ dshHome: home, names: ['mock-b'] })
    let inv = listManagedPlugins({ dshHome: home })
    expect(inv.plugins.map(p => p.bundle)).toEqual(['mock-a']) // 移出清单后不再有层可读
    expect(inv.quarantined.map(q => q.name)).toEqual(['mock-b'])
    const restore = restoreBundle({ dshHome: home, name: 'mock-b' })
    expect(restore.written).toEqual(['mock-b'])
    inv = listManagedPlugins({ dshHome: home })
    expect(inv.plugins.map(p => p.bundle).sort()).toEqual(['mock-a', 'mock-b'])
    expect(inv.quarantined).toEqual([])
    expect(restoreBundle({ dshHome: home, name: 'mock-b' }).written).toEqual([])
  })

  it('corrupt home layer: inventory degrades with hint, actions throw without touching disk', () => {
    const home = seedHome('corrupt', [{ name: 'mock-a', entries: [{ id: 'mock-a' }] }])
    writeFileSync(join(home, 'cordis.patch.yml'), '- insert: [ oops')
    const inv = listManagedPlugins({ dshHome: home })
    expect(inv.corruptHint).toBeDefined()
    expect(() => setPluginEnabled({ dshHome: home, bundle: 'mock-a', enabled: false })).toThrow()
    expect(readFileSync(join(home, 'cordis.patch.yml'), 'utf8')).toBe('- insert: [ oops')
  })

  it('unknown bundle and row-less bundle are rejected', () => {
    const home = seedHome('edge', [
      { name: 'mock-a', entries: [] },
      { name: 'mock-b', entries: [{ id: 'mock-b' }] },
    ])
    expect(() => setPluginEnabled({ dshHome: home, bundle: 'nope', enabled: false })).toThrow(/未找到/)
    expect(() => setPluginEnabled({ dshHome: home, bundle: 'mock-a', enabled: false })).toThrow(/没有可停用/)
  })
})

describe('buildPluginSection', () => {
  const noopActions: PluginSectionActions = { onToggle: () => {}, onDisableAll: () => {}, onEnableAll: () => {}, onRestore: () => {} }

  function itemsOf(inv: ManagedInventory): Array<Record<string, unknown>> {
    const section = buildPluginSection(inv, noopActions) as { submenu?: Array<Record<string, unknown>> }
    return section.submenu ?? []
  }

  it('renders checkbox states, suffixes and disables broken/native rows', () => {
    const items = itemsOf({
      plugins: [
        { bundle: 'ok', version: '1.0.0', entryIds: ['ok'], state: 'enabled', nativeDisabledOnly: false, broken: false },
        { bundle: 'off', entryIds: ['off'], state: 'disabled', reason: 'guard', nativeDisabledOnly: false, broken: false },
        { bundle: 'part', entryIds: ['p1', 'p2'], state: 'mixed', reason: 'webui', nativeDisabledOnly: false, broken: false },
        { bundle: 'dead', entryIds: ['dead'], state: 'enabled', nativeDisabledOnly: false, broken: true },
        { bundle: 'native', entryIds: ['native'], state: 'disabled', nativeDisabledOnly: true, broken: false },
      ],
      quarantined: [{ name: 'gone' }],
    })
    expect(items[0]).toMatchObject({ label: 'ok 1.0.0', type: 'checkbox', checked: true, enabled: true })
    expect(items[1]).toMatchObject({ label: 'off（守卫停用）', checked: false, enabled: true })
    expect(items[2]).toMatchObject({ label: 'part（页面内停用·部分停用）', checked: false, enabled: true })
    expect(items[3]).toMatchObject({ label: 'dead（残缺）', enabled: false })
    expect(items[4]).toMatchObject({ label: 'native（包内停用）', checked: false, enabled: false })
    const restore = items.find(i => typeof i.label === 'string' && i.label.includes('gone'))
    expect(restore).toMatchObject({ label: '↩ gone（已移出清单，点击恢复）' })
    expect(items.some(i => i.label === '全部停用…')).toBe(true)
    expect(items.some(i => i.label === '全部启用…')).toBe(true)
  })

  it('caps plugin entries at 20 with an overflow row, and shows an empty placeholder', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ bundle: `p${i}`, entryIds: [`p${i}`], state: 'enabled' as const, nativeDisabledOnly: false, broken: false }))
    const items = itemsOf({ plugins: many, quarantined: [] })
    const checkboxCount = items.filter(i => i.type === 'checkbox').length
    expect(checkboxCount).toBe(20)
    expect(items.some(i => i.label === '…其余 5 个（请到应用内插件页管理）')).toBe(true)
    const empty = itemsOf({ plugins: [], quarantined: [] })
    expect(empty.some(i => i.label === '暂无已安装插件')).toBe(true)
  })

  it('checkbox click forwards the user-intended state (menuItem.checked after toggle)', () => {
    const toggles: Array<[string, boolean]> = []
    const actions: PluginSectionActions = { ...noopActions, onToggle: (bundle, enabled) => { toggles.push([bundle, enabled]) } }
    const section = buildPluginSection({
      plugins: [{ bundle: 'x', entryIds: ['x'], state: 'enabled', nativeDisabledOnly: false, broken: false }],
      quarantined: [],
    }, actions) as { submenu?: Array<{ label?: string; click?: (item: { checked?: boolean }) => void }> }
    const checkbox = section.submenu!.find(i => i.label === 'x')!
    checkbox.click!({ checked: false })
    checkbox.click!({ checked: true })
    expect(toggles).toEqual([['x', false], ['x', true]])
  })
})
