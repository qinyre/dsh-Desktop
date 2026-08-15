import type { ServerRequestFrame } from './frame'

/**
 * 交互通知去重（设计书 §6）：approval 用 payload.approvalId，question 用信封 rpcId
 * （question/requested payload 无身份字段；question/resolved 以 questionRpcId 回显）。
 */
export class InteractionDedup {
  private readonly seenKeys = new Set<string>()

  seen(frame: ServerRequestFrame): boolean {
    const key = this.key(frame)
    if (key === undefined) return false
    if (this.seenKeys.has(key)) return true
    this.seenKeys.add(key)
    return false
  }

  resolve(frame: ServerRequestFrame): void {
    const key = this.key(frame)
    if (key !== undefined) this.seenKeys.delete(key)
  }

  private key(frame: ServerRequestFrame): string | undefined {
    if (frame.payload.type === 'approval/requested' || frame.payload.type === 'approval/resolved') {
      const id = frame.payload.approvalId
      return typeof id === 'string' ? `a:${id}` : undefined
    }
    if (frame.payload.type === 'question/requested') return `q:${frame.rpcId}`
    if (frame.payload.type === 'question/resolved') {
      const id = frame.payload.questionRpcId
      return typeof id === 'string' ? `q:${id}` : undefined
    }
    return undefined
  }
}
