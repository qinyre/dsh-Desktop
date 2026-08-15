import { describe, expect, it } from 'vitest'
import { backoffDelayMs } from './backoff'

describe('backoffDelayMs', () => {
  it('is exponential 1s/2s/4s and capped', () => {
    expect(backoffDelayMs(1)).toBe(1000)
    expect(backoffDelayMs(2)).toBe(2000)
    expect(backoffDelayMs(3)).toBe(4000)
    expect(backoffDelayMs(99)).toBe(4000)
  })
})
