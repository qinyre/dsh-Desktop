import { describe, expect, it } from 'vitest'
import { parseReadyLine, parseReadyPort } from './url-line'

describe('parseReadyPort（兼容入口）', () => {
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

describe('parseReadyLine（0.1.2-alpha 起就绪行带进程令牌）', () => {
  it('captures port and token from the authenticated URL', () => {
    expect(parseReadyLine('dsh web: http://127.0.0.1:41234/?token=AbC_-123')).toEqual({ port: 41234, token: 'AbC_-123' })
  })
  it('token 与 LAN 后缀共存时仍正确截取', () => {
    expect(parseReadyLine('dsh web: http://127.0.0.1:41234/?token=x1 (LAN: http://192.168.1.5:41234/?token=x1)')?.token).toBe('x1')
  })
  it('旧运行时无 token：token 为 undefined', () => {
    expect(parseReadyLine('dsh web: http://127.0.0.1:41234')).toEqual({ port: 41234, token: undefined })
  })
  it('非就绪行返回 undefined', () => {
    expect(parseReadyLine('[loader] mounted 41 rows')).toBeUndefined()
  })
})
