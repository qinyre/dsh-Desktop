import { BrowserWindow, Notification } from 'electron'
import type { SidecarEvents } from '../sidecar/sidecar-manager'
import { mintSidecarCookie } from '../sidecar/auth'
import { parseMuxServerMessage } from './frame'
import { NotifyCooldown } from './notify-cooldown'
import { ReconnectBackoff } from './reconnect-backoff'
import { lastAssistantText, summarizeReply } from './reply-summary'
import { RunningEdge } from './running-edge'
import { shouldNotify } from './notify-gating'

/** $events 逻辑流的下行帧（stream-protocol.ts / client/remote-events.ts 源码实锚）。 */
interface ReadyFrame { type: 'ready'; clientId: string }
interface EmitFrame { type: 'emit'; event: string; args: readonly unknown[] }
interface WaterfallFrame { type: 'waterfall'; event: string; eventId: string }

/** 触发桌面通知的两类交互 waterfall（$events/result 必答，见下）。 */
const INTERACTION_EVENTS = new Set(['approval/request', 'user-questions/request'])

/** Node/undici 与 Electron 主进程的 WebSocket 都接受 {headers} 非标第二参（ws-headers-probe 实测）。 */
type HeaderedWebSocketCtor = new (url: string, options?: { headers?: Record<string, string> }) => WebSocket

/** 一次回合完成增强快照：标题投影 + 末条回复原文（任一缺席为 undefined）。 */
interface TurnSnapshot { title: string | undefined; reply: string | undefined }

/** 一条在途快照流：首帧（snapshot）到达即收，超时/断流作废。 */
interface PendingSnapshot {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * 通知水龙头（设计书 §6）：dsh 0.1.2-alpha 起单条 WS `/api/remote.mux` 上的
 * `$events` 逻辑流（open/cancel 上行、item/end/error 下行）。就绪首帧 ready
 * 携带 clientId——它绑定本代事件流，也是 waterfall 应答 RPC 的回执凭据。
 *
 * **waterfall 必答**：approval/request、user-questions/request 以 waterfall 模式
 * 投递给全部在线代（gateway index.ts：pending.deliveries），主机等所有代回
 * `next` 才放行链条——桌面只读旁观，收到任何 waterfall 都必须立刻经
 * `POST /api/$events/result` 回 `{kind:'next'}`，否则会挂死用户的批准交互
 * （直到本连接断开被网关除名）。`cancel` 帧代表该 waterfall 已在他处落定。
 *
 * 回合完成通知（api-session/status 的 true→false 边沿）做一次内容增强：在同一条
 * socket 上复用 `session/follow` 逻辑流开一次性快照流（首帧 snapshot 同时携带
 * records 与 projections——标题就来自 projections.values.title，旧版 mux 广播
 * 免订阅拿会话名的通道已随 apiproxy 一同删除）。任一环节拿不到都回退通用文案，
 * 链路本身不抛错。
 */
export class EventTap {
  private readonly edge = new RunningEdge()
  private readonly backoff = new ReconnectBackoff()
  private readonly cooldown = new NotifyCooldown()
  private socket: WebSocket | undefined
  private generation = 0
  private port: number | undefined
  private cookie: string | undefined
  private clientId: string | undefined
  private closed = false
  private reconnectTimer: NodeJS.Timeout | undefined
  private readonly snapshots = new Map<string, PendingSnapshot>()

  constructor(private readonly opts: { getMainWindow(): BrowserWindow | undefined; canNotify?: () => boolean }) {}

  // 参数保持结构化（不依赖 SidecarManager 类）：on 的形状镜像 manager 的泛型签名，
  // 非泛型重载形式与 `<K extends keyof SidecarEvents>` 的实现做结构兼容时推不出 K。
  attach(sidecar: {
    on<K extends keyof SidecarEvents>(event: K, listener: (payload: Parameters<SidecarEvents[K]>[0]) => void): unknown
    readonly token: string | undefined
  }): void {
    sidecar.on('ready', (port) => {
      this.backoff.reset() // 换端口是新一轮生命周期，退避从头计
      const token = sidecar.token
      if (token !== undefined) {
        // 鉴权是 connect 的前置（WS 升级要 cookie）；兑换失败也照常连——旧运行时
        // 或竞态窗口下让服务端裁决，重连机制兜底。
        void mintSidecarCookie({ port, token }).then((cookie) => {
          this.cookie = cookie
          this.connect(port)
        })
        return
      }
      this.cookie = undefined
      this.connect(port)
    })
    sidecar.on('statechange', (state) => { if (state !== 'ready') this.disconnect() })
  }

  private connect(port: number): void {
    this.disconnect()
    this.port = port
    const generation = ++this.generation
    const socket = new (WebSocket as unknown as HeaderedWebSocketCtor)(
      `ws://127.0.0.1:${port}/api/remote.mux`,
      this.cookie === undefined ? undefined : { headers: { cookie: this.cookie } },
    )
    socket.addEventListener('open', () => {
      if (generation !== this.generation) return // 换代后的迟到 open 不计入恢复
      this.send(socket, { type: 'open', streamId: 'events', endpoint: '$events', payload: { args: {} } })
    })
    socket.addEventListener('message', (event) => this.handleMux(generation, socket, String(event.data)))
    // error 后必有 close；重连统一由 close 收口（EventTarget 语义下未监听的 error 不抛，
    // 但显式挂空监听可防未来实现差异，也让意图可见）。
    socket.addEventListener('error', () => { /* handled by close */ })
    socket.addEventListener('close', () => {
      if (generation !== this.generation) return // 我们主动断开或已换代
      this.failSnapshots(new Error('remote.mux closed'))
      this.reconnectTimer = setTimeout(() => {
        if (!this.closed && this.port !== undefined) this.connect(this.port)
      }, this.backoff.nextDelayMs())
    })
    this.socket = socket
  }

  private disconnect(): void {
    this.generation++ // 使所有在途 close/message 回调失效
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.clientId = undefined
    this.failSnapshots(new Error('event tap disconnected'))
    this.socket?.close()
    this.socket = undefined
  }

  close(): void {
    this.closed = true
    this.disconnect()
  }

  /** 上行帧出口：换代或非 OPEN 状态下静默丢弃（下游靠 close/超时收口）。 */
  private send(socket: WebSocket, message: unknown): void {
    if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) return
    try {
      socket.send(JSON.stringify(message))
    } catch {
      /* 发送失败由 close 收口重连 */
    }
  }

  private handleMux(generation: number, socket: WebSocket, raw: string): void {
    if (generation !== this.generation) return
    const frame = parseMuxServerMessage(raw)
    if (frame === undefined) return
    if (frame.type === 'item' && frame.streamId === 'events') {
      this.handleDownlink(frame.value)
      return
    }
    if ((frame.type === 'end' || frame.type === 'error') && frame.streamId === 'events') {
      // 事件代终结（宿主侧事件源断流）。主动关 socket 走 close 统一重连。
      socket.close()
      return
    }
    if (frame.type === 'item') this.settleSnapshot(frame.streamId, frame.value)
    else this.failSnapshot(frame.streamId, new Error(`stream ${frame.type}`))
  }

  /** $events 流下行帧分发：ready 绑代、emit 做边沿、waterfall 先应答再通知。 */
  private handleDownlink(value: unknown): void {
    const frame = value as { type?: unknown } | null | undefined
    if (frame === null || typeof frame !== 'object') return
    if (frame.type === 'ready') {
      const clientId = (frame as ReadyFrame).clientId
      if (typeof clientId === 'string' && clientId !== '') {
        this.clientId = clientId
        this.backoff.socketOpened()
      }
      return
    }
    if (frame.type === 'emit') {
      const emit = frame as EmitFrame
      if (emit.event === 'api-session/status') {
        const [sessionId, running] = emit.args
        const done = this.edge.update(sessionId, running)
        if (done !== undefined) void this.notifyTurnComplete(done)
      }
      return
    }
    if (frame.type === 'waterfall') {
      const waterfall = frame as WaterfallFrame
      // 先应答后通知：即使通知被门控吞掉也绝不扣住宿主的链条。
      this.replyNext(waterfall.eventId)
      if (INTERACTION_EVENTS.has(waterfall.event)) this.notifyInteractionPending()
    }
    // cancel：该 waterfall 已在他处落定，无需再动。
  }

  /** 经一元 RPC 回 `{kind:'next'}`；失败静默（断连时网关按除名清理交付）。 */
  private replyNext(eventId: string): void {
    const port = this.port
    const clientId = this.clientId
    if (port === undefined || clientId === undefined || typeof eventId !== 'string') return
    void fetch(`http://127.0.0.1:${port}/api/$events/result`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.cookie === undefined ? {} : { cookie: this.cookie }),
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method: '$events/result',
        payload: { args: { clientId, eventId, outcome: { kind: 'next' } } },
      }),
      signal: AbortSignal.timeout(4000),
    }).catch(() => { /* 应答失败等重连换代兜底 */ })
  }

  /** 等待确认的桌面通知：窗口可见/聚焦时不打扰，与旧版语义一致。 */
  private notifyInteractionPending(): void {
    const win = this.opts.getMainWindow()
    if (!shouldNotify(win?.isVisible() ?? false, win?.isFocused() ?? false)) return
    this.showDesktopNotification('agent 正在等待你的确认', '点击返回 DSH Desktop')
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

  /**
   * 回合完成通知：可见性门控 → 每会话冷却 → 内容增强。门控在前——窗口可见时
   * 直接返回且不消耗冷却，用户回到窗口后离开的下一条通知不受上一次静默影响。
   */
  private async notifyTurnComplete(sessionId: string): Promise<void> {
    const win = this.opts.getMainWindow()
    if (!shouldNotify(win?.isVisible() ?? false, win?.isFocused() ?? false)) return
    if (!this.cooldown.allow(sessionId)) return
    const snapshot = await this.fetchTurnSnapshot(sessionId)
    this.showDesktopNotification(
      snapshot?.title ?? '回合完成',
      snapshot?.reply !== undefined ? summarizeReply(snapshot.reply) : '点击返回 DSH Desktop',
    )
  }

  /** 边沿瞬间末条消息可能尚未落日志：为空时短延迟重试一次。 */
  private async fetchTurnSnapshot(sessionId: string): Promise<TurnSnapshot | undefined> {
    const first = await this.fetchSnapshotOnce(sessionId)
    if (first !== undefined && first.reply !== undefined) return first
    await new Promise(resolve => { setTimeout(resolve, 400) })
    return this.fetchSnapshotOnce(sessionId)
  }

  /**
   * 在共享 socket 上开一次性 `session/follow` 流取快照：首帧 snapshot 同时携带
   * records（末条回复）与 projections（title 投影）。任何失败都吞掉返回 undefined。
   */
  private fetchSnapshotOnce(sessionId: string): Promise<TurnSnapshot | undefined> {
    const socket = this.socket
    if (socket === undefined || socket.readyState !== WebSocket.OPEN) return Promise.resolve(undefined)
    const streamId = `snap-${crypto.randomUUID()}`
    return new Promise<TurnSnapshot | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.snapshots.delete(streamId)
        resolve(undefined)
      }, 4000)
      this.snapshots.set(streamId, {
        resolve: (value) => {
          clearTimeout(timer)
          this.snapshots.delete(streamId)
          this.send(socket, { type: 'cancel', streamId })
          resolve(this.snapshotOf(value))
        },
        reject: () => {
          clearTimeout(timer)
          this.snapshots.delete(streamId)
          resolve(undefined)
        },
        timer,
      })
      this.send(socket, {
        type: 'open',
        streamId,
        endpoint: 'session/follow',
        payload: { args: [{ address: { kind: 'session', sessionId }, maxMessages: 8 }] },
      })
    })
  }

  /** 从 snapshot 首帧防御式取出标题与末条回复；非 snapshot 形状返回 undefined。 */
  private snapshotOf(value: unknown): TurnSnapshot | undefined {
    const frame = value as { type?: unknown; records?: unknown; projections?: { values?: { title?: unknown } } } | null
    if (frame === null || typeof frame !== 'object' || frame.type !== 'snapshot') return undefined
    const title = frame.projections?.values?.title
    return {
      title: typeof title === 'string' && title.trim() !== '' ? title : undefined,
      reply: lastAssistantText(frame.records),
    }
  }

  private settleSnapshot(streamId: string, value: unknown): void {
    this.snapshots.get(streamId)?.resolve(value)
  }

  private failSnapshot(streamId: string, error: Error): void {
    this.snapshots.get(streamId)?.reject(error)
  }

  private failSnapshots(error: Error): void {
    for (const pending of this.snapshots.values()) pending.reject(error)
    this.snapshots.clear()
  }
}
