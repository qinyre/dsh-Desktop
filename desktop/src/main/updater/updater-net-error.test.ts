import { describe, expect, it } from 'vitest'
import { describeCheckError, isTransientNetError } from './updater-controller'

describe('isTransientNetError', () => {
  it('matches Chromium net errors and errno-style connection failures', () => {
    expect(isTransientNetError(new Error('net::ERR_CONNECTION_CLOSED'))).toBe(true)
    expect(isTransientNetError(new Error('net::ERR_CONNECTION_RESET'))).toBe(true)
    expect(isTransientNetError(new Error('net::ERR_TIMED_OUT'))).toBe(true)
    expect(isTransientNetError(Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' }))).toBe(true)
  })

  it('does not treat HTTP-level feed errors (404 latest.yml) as transient', () => {
    expect(isTransientNetError(new Error('Cannot find latest.yml in the latest release artifacts: HttpError: 404'))).toBe(false)
  })
})

describe('describeCheckError', () => {
  it('maps common network failures to a one-line human reason', () => {
    expect(describeCheckError(new Error('Error: net::ERR_CONNECTION_CLOSED'))).toBe('到更新服务器的连接被中断（网络不稳定），可稍后重试')
    expect(describeCheckError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe('当前没有网络连接')
    expect(describeCheckError(new Error('net::ERR_TIMED_OUT'))).toBe('连接更新服务器超时，可稍后重试')
  })

  it('truncates raw HttpError dumps (response headers) instead of showing them in full', () => {
    const dump = `HttpError: 404 ${'x-header-value: y\n'.repeat(40)}`
    const text = describeCheckError(new Error(dump))
    expect(text.length).toBeLessThanOrEqual(241)
    // String(error) 带 "Error: " 前缀，截断后仍以原始消息开头。
    expect(text.startsWith('Error: HttpError: 404')).toBe(true)
    expect(text.endsWith('…')).toBe(true)
  })
})
