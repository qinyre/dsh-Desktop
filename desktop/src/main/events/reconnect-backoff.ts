import { backoffDelayMs } from '../sidecar/backoff'

/**
 * 事件流重连退避：两条下行 WS 任一断开即整体重建，重建间隔沿崩溃退避曲线
 * 倍增（1s→2s→4s 封顶）。固定间隔重连在服务端长时间不可达时以恒定频率敲门，
 * 退避把它压成收敛脉冲；双流都重新 open（真正痊愈）或换端口新一轮时才复位。
 */
export class ReconnectBackoff {
  private attempt = 0
  private opened = 0

  /** 一条 socket open 时调用；返回 true 表示双流都已恢复（内部随即复位）。 */
  socketOpened(): boolean {
    this.opened += 1
    if (this.opened < 2) return false
    this.reset()
    return true
  }

  /** 下一次重连应等待的毫秒数。 */
  nextDelayMs(): number {
    this.attempt += 1
    return backoffDelayMs(this.attempt)
  }

  /** 整体复位（sidecar 换端口 = 新一轮生命周期）。 */
  reset(): void {
    this.attempt = 0
    this.opened = 0
  }
}
