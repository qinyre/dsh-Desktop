import { describe, expect, it } from 'vitest'
import { ReconnectBackoff } from './reconnect-backoff'

describe('ReconnectBackoff', () => {
  it('grows 1s → 2s → 4s and caps there', () => {
    const backoff = new ReconnectBackoff()
    expect(backoff.nextDelayMs()).toBe(1000)
    expect(backoff.nextDelayMs()).toBe(2000)
    expect(backoff.nextDelayMs()).toBe(4000)
    expect(backoff.nextDelayMs()).toBe(4000)
  })
  it('resets once both sockets are open again', () => {
    const backoff = new ReconnectBackoff()
    backoff.nextDelayMs()
    backoff.nextDelayMs()
    expect(backoff.socketOpened()).toBe(false) // 第一条流恢复不算痊愈
    expect(backoff.socketOpened()).toBe(true) // 双流都 open 才复位
    expect(backoff.nextDelayMs()).toBe(1000)
  })
  it('reset returns to the first step (new port = new cycle)', () => {
    const backoff = new ReconnectBackoff()
    backoff.nextDelayMs()
    backoff.reset()
    expect(backoff.nextDelayMs()).toBe(1000)
  })
})
