import { describe, expect, it } from 'vitest'
import { probeDbusName, type DbusExec } from './dbus-probe'

const enoent = (): Error => Object.assign(new Error('spawn busctl ENOENT'), { code: 'ENOENT' })
const timeout = (): Error => Object.assign(new Error('timed out'), { killed: true })
const busError = (): Error => new Error('Failed to connect to bus')

let seq = 0
const uniqueName = (): string => `org.example.Probe${seq++}`

describe('probeDbusName（busctl→gdbus 级联 + 判定矩阵）', () => {
  it('parses busctl stdout "b true"/"b false"', async () => {
    const exec: DbusExec = async (cmd) => ({ stdout: cmd === 'busctl' ? 'b true' : '' })
    await expect(probeDbusName(uniqueName(), exec)).resolves.toBe(true)
    const execFalse: DbusExec = async (cmd) => ({ stdout: cmd === 'busctl' ? '   b false' : '' })
    await expect(probeDbusName(uniqueName(), execFalse)).resolves.toBe(false)
  })
  it('busctl present but the session bus is missing → deterministically false (no fallback needed)', async () => {
    const exec: DbusExec = async (cmd) => { if (cmd === 'busctl') throw busError(); throw enoent() }
    await expect(probeDbusName(uniqueName(), exec)).resolves.toBe(false)
  })
  it('falls back to gdbus when busctl is not installed', async () => {
    const exec: DbusExec = async (cmd) => {
      if (cmd === 'busctl') throw enoent()
      return { stdout: '(true,)' }
    }
    await expect(probeDbusName(uniqueName(), exec)).resolves.toBe(true)
  })
  it('gdbus prints GVariant booleans without quotes — "(false,)" is a negative', async () => {
    const exec: DbusExec = async (cmd) => {
      if (cmd === 'busctl') throw enoent()
      return { stdout: '(false,)' }
    }
    await expect(probeDbusName(uniqueName(), exec)).resolves.toBe(false)
  })
  it('both tools missing → unknown (null)', async () => {
    const exec: DbusExec = async () => { throw enoent() }
    await expect(probeDbusName(uniqueName(), exec)).resolves.toBeNull()
  })
  it('exec timeout → unknown (null)', async () => {
    const exec: DbusExec = async () => { throw timeout() }
    await expect(probeDbusName(uniqueName(), exec)).resolves.toBeNull()
  })
  it('caches the result per name (second probe does not re-exec)', async () => {
    let calls = 0
    const exec: DbusExec = async () => { calls++; return { stdout: 'b true' } }
    const name = uniqueName()
    await expect(probeDbusName(name, exec)).resolves.toBe(true)
    await expect(probeDbusName(name, exec)).resolves.toBe(true)
    expect(calls).toBe(1)
  })
})
