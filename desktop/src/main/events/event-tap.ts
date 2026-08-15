import { BrowserWindow, Notification } from 'electron'
import type { SidecarEvents } from '../sidecar/sidecar-manager'
import { InteractionDedup } from './dedup'
import { parseServerRequest } from './frame'
import { RunningEdge } from './running-edge'
import { shouldNotify } from './notify-gating'

/**
 * 通知水龙头（设计书 §6）：两条只下行 WS；不发送任何帧（协议违规会被服务端 1008 关闭）。
 * ready 才连，非 ready 即断；重连指向新端口。
 */
export class EventTap {
  private readonly dedup = new InteractionDedup()
  private readonly edge = new RunningEdge()
  private sockets: WebSocket[] = []
  private generation = 0
  private port: number | undefined
  private closed = false
  private reconnectTimer: NodeJS.Timeout | undefined

  constructor(private readonly opts: { getMainWindow(): BrowserWindow | undefined }) {}

  // 参数保持结构化（不依赖 SidecarManager 类）：on 的形状镜像 manager 的泛型签名，
  // 非泛型重载形式与 `<K extends keyof SidecarEvents>` 的实现做结构兼容时推不出 K。
  attach(sidecar: {
    on<K extends keyof SidecarEvents>(event: K, listener: (payload: Parameters<SidecarEvents[K]>[0]) => void): unknown
  }): void {
    sidecar.on('ready', (port) => this.connect(port))
    sidecar.on('statechange', (state) => { if (state !== 'ready') this.disconnect() })
  }

  private connect(port: number): void {
    this.disconnect()
    this.port = port
    const generation = ++this.generation
    for (const path of ['/api/events.mux', '/api/events.host']) {
      const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`)
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
        }, 2000)
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
    let title: string | undefined
    if (type === 'approval/requested' || type === 'question/requested') {
      if (this.dedup.seen(frame)) return
      title = 'agent 正在等待你的确认'
    } else if (type === 'host/session-status') {
      const sessionId = this.edge.update(frame)
      if (sessionId === undefined) return
      title = '回合完成'
    } else {
      return
    }
    const win = this.opts.getMainWindow()
    if (!shouldNotify(win?.isVisible() ?? false, win?.isFocused() ?? false)) return
    const notification = new Notification({ title, body: '点击返回 Dosket' })
    notification.on('click', () => this.opts.getMainWindow()?.focus())
    notification.show()
  }
}
