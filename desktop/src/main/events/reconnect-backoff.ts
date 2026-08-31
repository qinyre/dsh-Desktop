import { backoffDelayMs } from '../sidecar/backoff'

/**
 * 事件流重连退避：单条 WS（remote.mux 上的 $events 流）断开即重建，重建间隔沿
 * 崩溃退避曲线倍增（1s→2s→4s 封顶）。固定间隔重连在服务端长时间不可达时以恒定
 * 频率敲门，退避把它压成收敛脉冲；$events 首帧 ready（真正痊愈）或换端口新一轮
 * 时才复位。
 */
export class ReconnectBackoff {
  private attempt = 0
  private opened = false

  /** $events 流 ready 时调用；true 表示本代已恢复（内部随即复位）。 */
  socketOpened(): boolean {
    if (this.opened) return false
    this.opened = true
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
    this.opened = false
  }
}
