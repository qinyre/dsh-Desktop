import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ensurePnpmShim, prependPath } from './pnpm-shim'

const dir = mkdtempSync(join(tmpdir(), 'dosket-shim-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('ensurePnpmShim（设计书 §7：运行时生成，ELECTRON_RUN_AS_NODE 驱动 pnpm）', () => {
  it('writes a pnpm.cmd on win32 wrapping execPath + pnpm cli', async () => {
    const shimDir = join(dir, 'win')
    await ensurePnpmShim({ execPath: 'C:\\app\\Dosket.exe', shimDir, resolvePnpmCli: () => 'C:\\app\\pnpm.cjs', platform: 'win32' })
    const content = readFileSync(join(shimDir, 'pnpm.cmd'), 'utf8')
    expect(content).toContain('ELECTRON_RUN_AS_NODE=1')
    expect(content).toContain('C:\\app\\Dosket.exe')
    expect(content).toContain('C:\\app\\pnpm.cjs')
  })
  it('writes a posix shell shim', async () => {
    const shimDir = join(dir, 'posix')
    await ensurePnpmShim({ execPath: '/app/Dosket', shimDir, resolvePnpmCli: () => '/app/pnpm.cjs', platform: 'linux' })
    const content = readFileSync(join(shimDir, 'pnpm'), 'utf8')
    expect(content.startsWith('#!/bin/sh')).toBe(true)
    expect(content).toContain('ELECTRON_RUN_AS_NODE=1')
  })
})

describe('prependPath', () => {
  it('prepends with the platform separator', () => {
    expect(prependPath('C:\\a;C:\\b', 'C:\\shim', 'win32')).toBe('C:\\shim;C:\\a;C:\\b')
    expect(prependPath('/a:/b', '/shim', 'linux')).toBe('/shim:/a:/b')
  })
  it('does not misread a drive-letter colon as the POSIX separator (single-entry Windows PATH)', () => {
    expect(prependPath('C:\\Windows\\System32', 'C:\\shim', 'win32')).toBe('C:\\shim;C:\\Windows\\System32')
  })
})
