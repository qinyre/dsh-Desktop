/** 回合完成通知的每会话冷却（设计书 §6）：agent 多轮自主工作时抑制连发。 */

/**
 * 同一会话在 minIntervalMs 内只允许第一条通知通过。纯时钟驱动、无定时器：
 * 错过冷却窗口的下一条（而非积压的最后一条）会照常弹出。
 */
export class NotifyCooldown {
  private readonly last = new Map<string, number>()

  constructor(private readonly minIntervalMs: number = 30_000) {}

  allow(sessionId: string, now: number = Date.now()): boolean {
    const previous = this.last.get(sessionId)
    if (previous !== undefined && now - previous < this.minIntervalMs) return false
    this.last.set(sessionId, now)
    return true
  }
}
