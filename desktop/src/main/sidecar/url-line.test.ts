import { describe, expect, it } from 'vitest'
import { parseReadyPort } from './url-line'

describe('parseReadyPort', () => {
  it('parses the plain readiness line', () => {
    expect(parseReadyPort('dsh web: http://127.0.0.1:41234')).toBe(41234)
  })
  it('tolerates a LAN suffix we never trigger (defensive, 设计书 §4)', () => {
    expect(parseReadyPort('dsh web: http://127.0.0.1:41234 (LAN: http://192.168.1.5:41234)')).toBe(41234)
  })
  it('ignores unrelated log lines', () => {
    expect(parseReadyPort('[loader] mounted 41 rows')).toBeUndefined()
    expect(parseReadyPort('')).toBeUndefined()
  })
})
