import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { SidecarLogger } from './sidecar-logger'

const dir = mkdtempSync(join(tmpdir(), 'dosket-log-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('SidecarLogger', () => {
  it('rotates keeping at most 5 files', () => {
    const logger = new SidecarLogger(dir)
    writeFileSync(logger.filePath, 'old')
    for (let i = 1; i <= 5; i++) writeFileSync(join(dir, `sidecar.log.${i}`), `v${i}`)
    logger.rotateSync()
    expect(readFileSync(join(dir, 'sidecar.log.5'), 'utf8')).toBe('v4')
    expect(existsSync(join(dir, 'sidecar.log'))).toBe(false)
  })
  it('appends lines', () => {
    const logger = new SidecarLogger(dir)
    logger.appendLine('hello')
    expect(readFileSync(logger.filePath, 'utf8')).toContain('hello')
  })
})
