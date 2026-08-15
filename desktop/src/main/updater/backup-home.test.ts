import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { backupDshHome } from './backup-home'

const root = mkdtempSync(join(tmpdir(), 'dosket-bk-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('backupDshHome（设计书 §8：更新前自动备份，保留最近 1 份）', () => {
  it('copies recursively and prunes old backups', async () => {
    const home = join(root, 'home')
    mkdirSync(join(home, 'profiles', 'web'), { recursive: true })
    writeFileSync(join(home, 'profiles', 'web', 'package.json'), '{}')
    let tick = 0
    const now = () => new Date(2026, 0, 1, 0, 0, tick++)
    const first = await backupDshHome(home, join(root, 'bk'), now)
    const second = await backupDshHome(home, join(root, 'bk'), now)
    expect(first).not.toBe(second)
    expect(readFileSync(join(second, 'profiles', 'web', 'package.json'), 'utf8')).toBe('{}')
    expect(existsSync(first)).toBe(false) // 剪枝：仅保留最近 1 份
  })
  it('missing home backs up nothing without throwing', async () => {
    expect(await backupDshHome(join(root, 'nope'), join(root, 'bk2'))).toBe('')
  })
})
