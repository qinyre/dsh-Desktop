import { describe, expect, it } from 'vitest'
import { RunningEdge } from './running-edge'

describe('RunningEdge（api-session/status 的 true→false 边沿，设计书 §6）', () => {
  it('fires only on falling edge per session', () => {
    const edge = new RunningEdge()
    expect(edge.update('s1', true)).toBeUndefined()
    expect(edge.update('s1', true)).toBeUndefined()
    expect(edge.update('s1', false)).toBe('s1')
    expect(edge.update('s1', false)).toBeUndefined()
  })
  it('tracks sessions independently', () => {
    const edge = new RunningEdge()
    edge.update('a', true)
    edge.update('b', true)
    expect(edge.update('a', false)).toBe('a')
    expect(edge.update('b', false)).toBe('b')
  })
  it('ignores malformed args', () => {
    const edge = new RunningEdge()
    expect(edge.update(undefined, true)).toBeUndefined()
    expect(edge.update('s', 'true')).toBeUndefined()
    expect(edge.update('s', false)).toBeUndefined() // 没见过 running=true，不算边沿
  })
})
