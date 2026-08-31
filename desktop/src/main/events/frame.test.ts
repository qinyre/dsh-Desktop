import { describe, expect, it } from 'vitest'
import { parseMuxServerMessage } from './frame'

describe('parseMuxServerMessage（线上格式：gateway stream-protocol.ts）', () => {
  it('parses item frames with and without value', () => {
    const withValue = parseMuxServerMessage('{"type":"item","streamId":"events","value":{"type":"ready","clientId":"c1"}}')
    expect(withValue?.type).toBe('item')
    if (withValue?.type === 'item') {
      expect(withValue.streamId).toBe('events')
      expect((withValue.value as { clientId?: string }).clientId).toBe('c1')
    }
    const bare = parseMuxServerMessage('{"type":"item","streamId":"s"}')
    expect(bare?.type).toBe('item')
  })
  it('parses end and error frames', () => {
    expect(parseMuxServerMessage('{"type":"end","streamId":"s"}')?.type).toBe('end')
    const err = parseMuxServerMessage('{"type":"error","streamId":"s","error":{"code":"gateway/bad-request","message":"nope","details":{}}}')
    expect(err?.type).toBe('error')
    if (err?.type === 'error') expect(err.error.code).toBe('gateway/bad-request')
  })
  it('rejects malformed shapes and non-mux messages', () => {
    expect(parseMuxServerMessage('not json')).toBeUndefined()
    expect(parseMuxServerMessage('{"type":"open","streamId":"s"}')).toBeUndefined() // 上行帧不入
    expect(parseMuxServerMessage('{"type":"item"}')).toBeUndefined() // 缺 streamId
    expect(parseMuxServerMessage('{"type":"error","streamId":"s","error":"boom"}')).toBeUndefined()
  })
})
