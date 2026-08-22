import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { bundleNameOfRowSource, findDuplicateEntryIds, isBundleRow, readLayerTable } from './patch-layers'

describe('readLayerTable', () => {
  const root = mkdtempSync(join(tmpdir(), 'patch-layers-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  function writeBundle(home: string, name: string, patch: string): void {
    const dir = join(home, 'profiles', 'web', 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.1', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(dir, 'cordis.patch.yml'), patch)
  }

  function writeManifest(home: string, bundles: string[], dependencies: string[]): void {
    const dir = join(home, 'profiles', 'web')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      dependencies: Object.fromEntries(dependencies.map(d => [d, '1'])),
      dsh: { profile: { bundles } },
    }))
  }

  it('extracts insert rows across bundle/profile/home layers in stack order', () => {
    const home = join(root, 'ok')
    writeBundle(home, 'p-a', '- insert:\n  - id: e-a\n    name: p-a\n')
    writeBundle(home, 'p-b', '- insert:\n  - id: e-b\n    name: p-b\n    disabled: true\n')
    writeManifest(home, ['p-a', 'p-b'], ['p-a', 'p-b'])
    writeFileSync(join(home, 'profiles', 'web', 'cordis.patch.yml'), '- insert:\n  - id: e-user\n    name: some-user-module\n')
    writeFileSync(join(home, 'cordis.patch.yml'), '- id: e-a\n  config: { x: 1 }\n')
    const table = readLayerTable({ dshHome: home })
    expect(table.rows.map(r => r.id)).toEqual(['e-a', 'e-b', 'e-user'])
    expect(table.rows[1]!.disabled).toBe(true)
    expect(table.idsByName.get('p-b')).toEqual(['e-b'])
    expect(table.bundles).toEqual(['p-a', 'p-b'])
    expect(table.tracked).toEqual(['p-a', 'p-b'])
    expect(table.corruptLayers).toEqual([])
    expect(table.missingBundles).toEqual([])
  })

  it('tracks only bundles that are also dependencies', () => {
    const home = join(root, 'tracked')
    writeBundle(home, 'p-user', '- insert:\n  - id: e-user\n    name: p-user\n')
    writeManifest(home, ['p-user', 'p-template'], ['p-user'])
    const table = readLayerTable({ dshHome: home })
    expect(table.tracked).toEqual(['p-user'])
    expect(table.missingBundles).toEqual([]) // 模板 bundle 缺 profile 副本不算缺件
  })

  it('reports corrupt bundle patch, corrupt home layer, and missing tracked bundle', () => {
    const home = join(root, 'broken')
    writeBundle(home, 'p-bad', '- insert: [ oops')
    writeManifest(home, ['p-bad', 'p-gone'], ['p-bad', 'p-gone'])
    writeFileSync(join(home, 'cordis.patch.yml'), '{ not a list')
    const table = readLayerTable({ dshHome: home })
    expect(table.corruptLayers.map(c => c.bundle)).toContain('p-bad')
    expect(table.corruptLayers.some(c => c.path === join(home, 'cordis.patch.yml'))).toBe(true)
    expect(table.missingBundles).toEqual(['p-gone'])
  })

  it('never throws on corrupt manifest or absent profile', () => {
    const home = join(root, 'empty')
    mkdirSync(home, { recursive: true })
    expect(readLayerTable({ dshHome: home }).rows).toEqual([])
    const home2 = join(root, 'badmanifest')
    mkdirSync(join(home2, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(home2, 'profiles', 'web', 'package.json'), '{ nope')
    const t = readLayerTable({ dshHome: home2 })
    expect(t.rows).toEqual([])
    expect(t.corruptLayers.some(c => c.path === join(home2, 'profiles', 'web', 'package.json'))).toBe(true)
  })

  it('finds duplicate entry ids and maps row sources to bundle names', () => {
    const home = join(root, 'dup')
    writeBundle(home, 'p-a', '- insert:\n  - id: same\n    name: p-a\n')
    writeBundle(home, 'p-b', '- insert:\n  - id: same\n    name: p-b\n')
    writeManifest(home, ['p-a', 'p-b'], ['p-a', 'p-b'])
    const table = readLayerTable({ dshHome: home })
    expect(findDuplicateEntryIds(table)).toEqual(['same'])
    expect(isBundleRow(table.rows[0]!.source)).toBe(true)
    expect(isBundleRow(join(home, 'cordis.patch.yml'))).toBe(false)
    expect(bundleNameOfRowSource(table.rows[0]!.source)).toBe('p-a')
    expect(bundleNameOfRowSource(table.rows[1]!.source)).toBe('p-b')
    expect(bundleNameOfRowSource(join(home, 'cordis.patch.yml'))).toBeUndefined()
  })

  it('extracts scoped package names as two segments', () => {
    expect(bundleNameOfRowSource(join('C:', 'x', 'node_modules', '@qinyre', 'dsh-plugin-x', 'cordis.patch.yml'))).toBe(join('@qinyre', 'dsh-plugin-x'))
    expect(bundleNameOfRowSource(join('C:', 'x', 'node_modules', 'plain', 'cordis.patch.yml'))).toBe('plain')
    expect(bundleNameOfRowSource(join('C:', 'x', 'node_modules'))).toBeUndefined()
  })
})
