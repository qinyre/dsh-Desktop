import { describe, expect, it } from 'vitest'
import { diagnoseLog } from './guard-diagnose'
import type { LayerTable } from './patch-layers'

const table: LayerTable = {
  rows: [
    { id: 'mock-crash', name: 'mock-crash', disabled: false, source: 'C:\\x\\node_modules\\mock-crash\\cordis.patch.yml' },
    { id: 'mock-pending', name: 'mock-pending', disabled: false, source: 'C:\\x\\node_modules\\mock-pending\\cordis.patch.yml' },
  ],
  idsByName: new Map([['mock-crash', ['mock-crash']], ['mock-pending', ['mock-pending']]]),
  bundles: ['mock-crash', 'mock-pending'],
  tracked: ['mock-crash', 'mock-pending'],
  corruptLayers: [],
  missingBundles: [],
}

describe('diagnoseLog', () => {
  it('maps import failure with MODULE_NOT_FOUND to dependency-missing and carries id+name', () => {
    const log = [
      'Error: failed to import loader entry mock-import (mock-import): Cannot find package \'./missing.js\' imported from C:/x/mock-import/index.js',
      '    at foo (bar:1:1)',
    ].join('\n')
    const f = diagnoseLog(log, undefined)
    expect(f).toHaveLength(1)
    expect(f[0]).toMatchObject({ key: 'entry:mock-import', kind: 'entry', id: 'mock-import', name: 'mock-import', category: 'dependency-missing', source: 'crash' })
  })

  it('maps apply failure without module-not-found to plugin-error', () => {
    const log = 'dsh: failed to apply loader entry mock-crash (mock-crash): Error: boom'
    const f = diagnoseLog(log, undefined)
    expect(f[0]).toMatchObject({ key: 'entry:mock-crash', category: 'plugin-error' })
  })

  it('parses the did-not-activate block: FAILED stack + PENDING service names', () => {
    const log = [
      'dsh: 2 entries did not activate',
      'mock-crash: Error: boom',
      '    at apply (file.js:2:3)',
      'mock-pending: pending (waiting for service: no-such-service-xyz)',
    ].join('\n')
    const f = diagnoseLog(log, table)
    const byKey = new Map(f.map(x => [x.key, x]))
    expect(byKey.get('entry:mock-crash')).toMatchObject({ category: 'plugin-error', name: 'mock-crash', id: 'mock-crash' })
    expect(byKey.get('entry:mock-pending')).toMatchObject({ category: 'dependency-missing' })
    expect(byKey.get('entry:mock-pending')!.reason).toContain('no-such-service-xyz')
  })

  it('maps names to ids via the layer table inside the activate block', () => {
    const log = ['dsh: 1 entry did not activate', 'mock-crash: Error: boom'].join('\n')
    const f = diagnoseLog(log, table)
    expect(f[0]).toMatchObject({ key: 'entry:mock-crash', id: 'mock-crash' })
  })

  it('parses plugin(s) failed to load, duplicate id, service conflict, bundle signatures, parse failure with spaced path', () => {
    const log = [
      'dsh: plugin(s) failed to load: mock-a, mock-b; Cordis startup failed',
      'TypeError: duplicate loader entry id: mock-dup',
      'Error: service "webServer" has been registered at <include/mock-x>',
      'Error: cannot resolve profile bundle "mock-gone" from the dsh installation or C:/p; ...',
      'warning: skipping profile bundle "mock-gone" for this boot',
      'dsh: failed to parse patches C:\\Users\\John Doe\\dsh-home\\cordis.patch.yml: YAMLParseError: bad',
    ].join('\n')
    const f = diagnoseLog(log, table)
    const byKey = new Map(f.map(x => [x.key, x]))
    expect(byKey.get('entry:mock-a')).toMatchObject({ category: 'dependency-missing', name: 'mock-a' })
    expect(byKey.get('entry:mock-b')).toMatchObject({ name: 'mock-b' })
    expect(byKey.get('entry:mock-dup')).toMatchObject({ category: 'conflict', id: 'mock-dup' })
    expect(byKey.get('bundle:mock-gone')).toMatchObject({ kind: 'bundle', category: 'dependency-missing', bundle: 'mock-gone' })
    expect(byKey.get('file:C:\\Users\\John Doe\\dsh-home\\cordis.patch.yml')).toMatchObject({ kind: 'file', category: 'config-corrupt' })
    const svc = f.find(x => x.kind === 'service')
    expect(svc).toMatchObject({ category: 'conflict' })
  })

  it('promotes a service conflict to a quarantineable entry when the fiber names a known entry', () => {
    const log = 'Error: service "webServer" has been registered at <include/mock-crash/child>'
    const f = diagnoseLog(log, table)
    expect(f[0]).toMatchObject({ kind: 'entry', id: 'mock-crash', category: 'conflict' })
  })

  it('unwraps root-include apply failures instead of quarantining the include entry itself', () => {
    // 冒烟实测格式：duplicate id 从 mountRootInclude 路径抛出时被包成根 entry 的 apply 失败。
    const log = 'Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): duplicate loader entry id: mock-dup-entry'
    const f = diagnoseLog(log, undefined)
    const byKey = new Map(f.map(x => [x.key, x]))
    expect(byKey.has('entry:include')).toBe(false)
    expect(byKey.get('entry:mock-dup-entry')).toMatchObject({ category: 'conflict', id: 'mock-dup-entry' })
    const other = diagnoseLog('failed to apply loader entry include (cordis:include): some unknown composition error', undefined)
    expect(other).toHaveLength(1)
    expect(other[0]).toMatchObject({ kind: 'service', category: 'plugin-error' })
  })

  it('returns empty for unrelated crash logs and dedupes by key', () => {
    expect(diagnoseLog('EADDRINUSE whatever\n    at x', table)).toEqual([])
    const twice = diagnoseLog('duplicate loader entry id: mock-dup\nduplicate loader entry id: mock-dup', undefined)
    expect(twice).toHaveLength(1)
  })
})
