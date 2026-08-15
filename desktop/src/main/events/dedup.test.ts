import { describe, expect, it } from 'vitest'
import { InteractionDedup } from './dedup'

const approval = (approvalId: string) => ({ rpcId: 'r1', payload: { type: 'approval/requested', approvalId } })
const question = (rpcId: string) => ({ rpcId, payload: { type: 'question/requested', questions: [] } })

describe('InteractionDedup（设计书 §6：a:${approvalId} / q:${rpcId}，镜像上游 bufferedRequestKey）', () => {
  it('replayed approval/question frames do not re-fire', () => {
    const dedup = new InteractionDedup()
    expect(dedup.seen(approval('a1'))).toBe(false)
    expect(dedup.seen(approval('a1'))).toBe(true) // mux 重放（rpcId 原样复用）
    expect(dedup.seen(question('q9'))).toBe(false)
    expect(dedup.seen(question('q9'))).toBe(true)
  })
  it('resolved clears the entry so a new request with the same id notifies again', () => {
    const dedup = new InteractionDedup()
    dedup.seen(approval('a1'))
    dedup.resolve({ rpcId: 'r1', payload: { type: 'approval/resolved', approvalId: 'a1', outcome: 'allow-once' } })
    expect(dedup.seen(approval('a1'))).toBe(false)
    dedup.seen(question('q9'))
    dedup.resolve({ rpcId: 'other', payload: { type: 'question/resolved', questionRpcId: 'q9', outcome: 'answered' } })
    expect(dedup.seen(question('q9'))).toBe(false)
  })
  it('non-interaction frames are ignored', () => {
    const dedup = new InteractionDedup()
    expect(dedup.seen({ rpcId: 'r', payload: { type: 'session/event' } })).toBe(false)
    dedup.resolve({ rpcId: 'r', payload: { type: 'stream/error' } })
  })
})
