import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { GuardFinding } from './guard-diagnose'
import { GuardLedgerStore } from './guard-ledger'

describe('GuardLedgerStore', () => {
  const root = mkdtempSync(join(tmpdir(), 'guard-ledger-'))
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const finding = (key: string, reason = 'r'): GuardFinding => ({
    key, kind: 'entry', id: key.slice('entry:'.length), category: 'plugin-error',
    reason, source: 'crash', firstSeen: '2026-08-22T00:00:00.000Z',
  })

  it('records new findings into findings+unreported and returns them', () => {
    const file = join(root, 'a.json')
    const store = new GuardLedgerStore(file)
    const added = store.record([finding('entry:a'), finding('entry:b')])
    expect(added.map(f => f.key)).toEqual(['entry:a', 'entry:b'])
    const loaded = store.load()
    expect(loaded.findings.map(f => f.key)).toEqual(['entry:a', 'entry:b'])
    expect(loaded.unreported).toHaveLength(2)
  })

  it('merges by key: updates reason in place, keeps firstSeen, no duplicate unreported', () => {
    const file = join(root, 'b.json')
    const store = new GuardLedgerStore(file)
    store.record([finding('entry:a', 'first')])
    store.markReported()
    const added = store.record([finding('entry:a', 'second')])
    expect(added).toEqual([])
    const loaded = store.load()
    expect(loaded.findings).toHaveLength(1)
    expect(loaded.findings[0]!.reason).toBe('second')
    expect(loaded.findings[0]!.firstSeen).toBe('2026-08-22T00:00:00.000Z')
    expect(loaded.unreported).toEqual([])
  })

  it('markReported clears unreported; clear wipes everything', () => {
    const file = join(root, 'c.json')
    const store = new GuardLedgerStore(file)
    store.record([finding('entry:a')])
    store.markReported()
    expect(store.load().unreported).toEqual([])
    expect(store.load().findings).toHaveLength(1)
    store.clear()
    expect(store.load()).toEqual({ version: 1, findings: [], unreported: [] })
  })

  it('load tolerates missing and corrupt files', () => {
    const missing = new GuardLedgerStore(join(root, 'nope.json'))
    expect(missing.load()).toEqual({ version: 1, findings: [], unreported: [] })
    const corruptPath = join(root, 'corrupt.json')
    writeFileSync(corruptPath, '{ nope')
    expect(new GuardLedgerStore(corruptPath).load().findings).toEqual([])
  })

  it('persists as readable JSON', () => {
    const file = join(root, 'd.json')
    const store = new GuardLedgerStore(file)
    store.record([finding('entry:a')])
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1)
  })
})
