export interface ServerRequestFrame {
  rpcId: string
  payload: { type: string } & Record<string, unknown>
}

/** 解析 WS 下行帧（{type:'server-request',rpcId,method,payload}）。 */
export function parseServerRequest(raw: string): ServerRequestFrame | undefined {
  try {
    const obj = JSON.parse(raw) as { type?: unknown; rpcId?: unknown; payload?: unknown }
    if (obj.type !== 'server-request' || typeof obj.rpcId !== 'string') return undefined
    const payload = obj.payload as { type?: unknown } | undefined
    if (payload === undefined || typeof payload.type !== 'string') return undefined
    return { rpcId: obj.rpcId, payload: payload as ServerRequestFrame['payload'] }
  } catch {
    return undefined
  }
}
