/** /api/remote.mux 下行帧（dsh 0.1.2-alpha 网关 stream-protocol.ts 源码实锚）。 */
export interface MuxItemFrame {
  type: 'item'
  streamId: string
  value?: unknown
}

export interface MuxEndFrame {
  type: 'end'
  streamId: string
}

export interface MuxErrorFrame {
  type: 'error'
  streamId: string
  error: { code: string; message: string }
}

export type MuxServerMessage = MuxItemFrame | MuxEndFrame | MuxErrorFrame

/**
 * 解析 WS 下行帧：{type:'item',streamId,value?}|{type:'end',streamId}
 * |{type:'error',streamId,error:{code,message}}。不合形返回 undefined——上游
 * 协议是严格壳，宽容读取只会把真故障吞成静默失明。
 */
export function parseMuxServerMessage(raw: string): MuxServerMessage | undefined {
  try {
    const obj = JSON.parse(raw) as { type?: unknown; streamId?: unknown; value?: unknown; error?: unknown }
    if (typeof obj.streamId !== 'string') return undefined
    if (obj.type === 'item') return { type: 'item', streamId: obj.streamId, value: obj.value }
    if (obj.type === 'end') return { type: 'end', streamId: obj.streamId }
    if (obj.type === 'error'
      && typeof obj.error === 'object' && obj.error !== null
      && typeof (obj.error as { code?: unknown }).code === 'string'
      && typeof (obj.error as { message?: unknown }).message === 'string') {
      return { type: 'error', streamId: obj.streamId, error: obj.error as MuxErrorFrame['error'] }
    }
    return undefined
  } catch {
    return undefined
  }
}
