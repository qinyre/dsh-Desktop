import { describe, expect, it } from 'vitest'
import { parseServerRequest } from './frame'

describe('parseServerRequest（线上格式：websocket-downlink.ts serverRequest()）', () => {
  it('parses envelope and payload', () => {
    const frame = parseServerRequest('{"type":"server-request","rpcId":"r1","method":"approval/requested","payload":{"type":"approval/requested","sessionId":"s","approvalId":"a1","toolName":"bash"}}')
    expect(frame?.rpcId).toBe('r1')
    expect(frame?.payload.type).toBe('approval/requested')
    expect((frame?.payload as { approvalId?: string }).approvalId).toBe('a1')
  })
  it('rejects non-server-request and malformed json', () => {
    expect(parseServerRequest('{"type":"client-request"}')).toBeUndefined()
    expect(parseServerRequest('not json')).toBeUndefined()
  })
})
