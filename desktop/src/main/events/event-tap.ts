import { BrowserWindow, Notification } from 'electron'
import type { SidecarEvents } from '../sidecar/sidecar-manager'
import { InteractionDedup } from './dedup'
import { parseServerRequest } from './frame'
import { NotifyCooldown } from './notify-cooldown'
import { ReconnectBackoff } from './reconnect-backoff'
import { lastAssistantText, summarizeReply } from './reply-summary'
import { RunningEdge } from './running-edge'
import { shouldNotify } from './notify-gating'

/**
 * 通知水龙头（设计书 §6）：两条只下行 WS；不发送任何帧（协议违规会被服务端 1008 关闭）。
 * ready 才连，非 ready 即断；重连指向新端口。重连间隔走退避（reconnect-backoff），
 * 双流都重新 open 或换端口新一轮时复位。
 *
 * 回合完成通知（host/session-status 的 true→false 边沿）做一次内容增强：标题用
 * 会话名、正文用最后一条 agent 回复的摘要。会话名来自 mux 广播的 session/projection
 * （key==='title'，投影帧对所有连接广播、无需订阅）；正文在边沿时刻经
 * POST /api/session.history 现查（信封与浏览器载体一致：client-request + 单段端点名）。
 * 任一环节拿不到都回退通用文案，链路本身不抛错。
 */
export class EventTap {
  private readonly dedup = new InteractionDedup()
  private readonly edge = new RunningEdge()
  private readonly backoff = new ReconnectBackoff()
  private readonly cooldown = new NotifyCooldown()
  private readonly titles = new Map<string, string>()
  private sockets: WebSocket[] = []
  private generation = 0
  private port: number | undefined
  private closed = false
  private reconnectTimer: NodeJS.Timeout | undefined

  constructor(private readonly opts: { getMainWindow(): BrowserWindow | undefined; canNotify?: () => boolean }) {}

  // 参数保持结构化（不依赖 SidecarManager 类）：on 的形状镜像 manager 的泛型签名，
  // 非泛型重载形式与 `<K extends keyof SidecarEvents>` 的实现做结构兼容时推不出 K。
  attach(sidecar: {
    on<K extends keyof SidecarEvents>(event: K, listener: (payload: Parameters<SidecarEvents[K]>[0]) => void): unknown
  }): void {
    sidecar.on('ready', (port) => {
      this.backoff.reset() // 换端口是新一轮生命周期，退避从头计
      this.connect(port)
    })
    sidecar.on('statechange', (state) => { if (state !== 'ready') this.disconnect() })
  }

  private connect(port: number): void {
    this.disconnect()
    this.port = port
    const generation = ++this.generation
    for (const path of ['/api/events.mux', '/api/events.host']) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`)
      socket.addEventListener('open', () => {
        if (generation !== this.generation) return // 换代后的迟到 open 不计入恢复
        this.backoff.socketOpened()
      })
      socket.addEventListener('message', (event) => this.handle(String(event.data)))
      // error 后必有 close；重连统一由 close 收口（EventTarget 语义下未监听的 error 不抛，
      // 但显式挂空监听可防未来实现差异，也让意图可见）。
      socket.addEventListener('error', () => { /* handled by close */ })
      socket.addEventListener('close', () => {
        if (generation !== this.generation) return // 我们主动断开或已换代
        this.generation++ // 使兄弟 socket 的 close 失效：两流只整体重建一次（对齐上游语义）
        this.sockets = []
        this.reconnectTimer = setTimeout(() => {
          if (!this.closed && this.port !== undefined) this.connect(this.port)
        }, this.backoff.nextDelayMs())
      })
      this.sockets.push(socket)
    }
  }

  private disconnect(): void {
    this.generation++ // 使所有在途 close 回调失效
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    for (const socket of this.sockets) socket.close()
    this.sockets = []
  }

  close(): void {
    this.closed = true
    this.disconnect()
  }

  private handle(raw: string): void {
    const frame = parseServerRequest(raw)
    if (frame === undefined) return
    const type = frame.payload.type
    if (type === 'approval/resolved' || type === 'question/resolved') {
      this.dedup.resolve(frame)
      return
    }
    if (type === 'session/projection') {
      this.rememberTitle(frame.payload)
      return
    }
    if (type === 'host/session-removed') {
      const removed = frame.payload.sessionId
      if (typeof removed === 'string') this.titles.delete(removed)
      return
    }
    let title: string | undefined
    if (type === 'approval/requested' || type === 'question/requested') {
      if (this.dedup.seen(frame)) return
      title = 'agent 正在等待你的确认'
    } else if (type === 'host/session-status') {
      const sessionId = this.edge.update(frame)
      if (sessionId === undefined) return
      void this.notifyTurnComplete(sessionId)
      return
    } else {
      return
    }
    const win = this.opts.getMainWindow()
    if (!shouldNotify(win?.isVisible() ?? false, win?.isFocused() ?? false)) return
    this.showDesktopNotification(title, '点击返回 DSH Desktop')
  }

  /**
   * 桌面通知的统一出口：canNotify 前置门控（Linux 无通知守护时 Notification 有已知的
   * 抛错/挂起问题 electron#21912，探测未确认就不创建）+ 构造与 show 整段包裹——两者
   * 都可能因环境缺席而抛错，这是纯增强路径，吞掉不影响任何下游逻辑。
   */
  private showDesktopNotification(title: string, body: string): void {
    if (this.opts.canNotify !== undefined && !this.opts.canNotify()) return
    try {
      const notification = new Notification({ title, body })
      notification.on('click', () => this.opts.getMainWindow()?.focus())
      notification.show()
    } catch {
      /* 通知守护缺席等：静默 */
    }
  }

  /** 缓存 mux 广播的会话标题投影（key==='title'，string|null；null=清除）。 */
  private rememberTitle(payload: Record<string, unknown>): void {
    const sessionId = payload.sessionId
    if (payload.key !== 'title' || typeof sessionId !== 'string') return
    const value = payload.value
    if (typeof value === 'string' && value.trim() !== '') this.titles.set(sessionId, value)
    else if (value === null) this.titles.delete(sessionId)
  }

  /**
   * 回合完成通知：可见性门控 → 每会话冷却 → 内容增强。门控在前——窗口可见时
   * 直接返回且不消耗冷却，用户回到窗口后离开的下一条通知不受上一次静默影响。
   */
  private async notifyTurnComplete(sessionId: string): Promise<void> {
    const win = this.opts.getMainWindow()
    if (!shouldNotify(win?.isVisible() ?? false, win?.isFocused() ?? false)) return
    if (!this.cooldown.allow(sessionId)) return
    const title = this.titles.get(sessionId) ?? '回合完成'
    const reply = await this.fetchLastReply(sessionId)
    this.showDesktopNotification(title, reply !== undefined ? summarizeReply(reply) : '点击返回 DSH Desktop')
  }

  /** 边沿瞬间末条消息可能尚未投影完：为空时短延迟重试一次。 */
  private async fetchLastReply(sessionId: string): Promise<string | undefined> {
    const first = await this.fetchReplyOnce(sessionId)
    if (first !== undefined) return first
    await new Promise(resolve => { setTimeout(resolve, 400) })
    return this.fetchReplyOnce(sessionId)
  }

  /** 经 /api 一元 RPC 拉该会话的事件页并折叠最后一条回复；任何失败都吞掉返回 undefined。 */
  private async fetchReplyOnce(sessionId: string): Promise<string | undefined> {
    if (this.port === undefined) return undefined
    try {
      const response = await fetch(`http://127.0.0.1:${this.port}/api/session.history`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          type: 'client-request',
          rpcId: crypto.randomUUID(),
          method: 'session.history',
          payload: { sessionId },
        }),
        signal: AbortSignal.timeout(4000),
      })
      if (!response.ok) return undefined
      // 响应信封：{rpcId, result:{ok:true,value:{events}}|{ok:false,...}}
      const full = await response.json() as { result?: { ok?: unknown; value?: { events?: unknown } } }
      const result = full.result
      if (result === undefined || result.ok !== true || result.value === undefined) return undefined
      return lastAssistantText(result.value.events)
    } catch {
      return undefined
    }
  }
}
