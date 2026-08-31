/**
 * api-session/status 的每会话 true→false 边沿（"回合完成"，设计书 §6）。
 * 事件经 $events 流以 {emit,event,args:[sessionId,running]} 下发。
 */
export class RunningEdge {
  private readonly running = new Map<string, boolean>()

  update(sessionId: unknown, running: unknown): string | undefined {
    if (typeof sessionId !== 'string' || typeof running !== 'boolean') return undefined
    const was = this.running.get(sessionId) ?? false
    this.running.set(sessionId, running)
    return was && !running ? sessionId : undefined
  }
}
