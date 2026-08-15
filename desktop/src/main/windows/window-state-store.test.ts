import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { WindowStateStore } from './window-state-store'

const dir = mkdtempSync(join(tmpdir(), 'dsh-desktop-ws-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('WindowStateStore', () => {
  it('round-trips bounds', () => {
    const store = new WindowStateStore(join(dir, 'a.json'))
    store.save({ x: 10, y: 20, width: 1000, height: 700 })
    expect(store.load()).toEqual({ x: 10, y: 20, width: 1000, height: 700 })
  })
  it('defaults on missing/corrupt file', () => {
    expect(new WindowStateStore(join(dir, 'missing.json')).load()).toEqual({ x: 100, y: 100, width: 1200, height: 800 })
    const f = join(dir, 'corrupt.json')
    writeFileSync(f, '{oops')
    expect(new WindowStateStore(f).load()).toEqual({ x: 100, y: 100, width: 1200, height: 800 })
  })
})
