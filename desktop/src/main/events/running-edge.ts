import type { ServerRequestFrame } from './frame'

/** host/session-status 的每会话 true→false 边沿（"回合完成"，设计书 §6）。 */
export class RunningEdge {
  private readonly running = new Map<string, boolean>()

  update(frame: ServerRequestFrame): string | undefined {
    if (frame.payload.type !== 'host/session-status') return undefined
    const { sessionId, running } = frame.payload as { sessionId?: unknown; running?: unknown }
    if (typeof sessionId !== 'string' || typeof running !== 'boolean') return undefined
    const was = this.running.get(sessionId) ?? false
    this.running.set(sessionId, running)
    return was && !running ? sessionId : undefined
  }
}
