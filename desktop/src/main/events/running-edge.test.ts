import { describe, expect, it } from 'vitest'
import { RunningEdge } from './running-edge'

const status = (running: boolean) => ({ rpcId: 'r', payload: { type: 'host/session-status', sessionId: 's1', running } })

describe('RunningEdge（host/session-status 的 true→false 边沿，设计书 §6）', () => {
  it('fires only on falling edge per session', () => {
    const edge = new RunningEdge()
    expect(edge.update(status(true))).toBeUndefined()
    expect(edge.update(status(true))).toBeUndefined()
    expect(edge.update(status(false))).toBe('s1')
    expect(edge.update(status(false))).toBeUndefined()
  })
})
