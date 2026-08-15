import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { backoffDelayMs } from './backoff'
import type { ResolvedRuntime } from './runtime-resolver'
import type { SidecarLogger } from './sidecar-logger'
import { killSidecar } from './sidecar-process'
import { parseReadyPort } from './url-line'

export type SidecarState = 'idle' | 'spawning' | 'ready' | 'crashed' | 'failed'

export interface SidecarEvents {
  statechange(state: SidecarState): void
  ready(port: number): void
}

type Listener<K extends keyof SidecarEvents> = (payload: Parameters<SidecarEvents[K]>[0]) => void

/** sidecar 生命周期状态机（设计书 §4）。不 import electron。 */
export class SidecarManager {
  private child: ChildProcess | undefined
  private timer: NodeJS.Timeout | undefined
  private restarts = 0
  private stopping = false
  private _state: SidecarState = 'idle'
  private _port: number | undefined
  private readonly listeners: { [K in keyof SidecarEvents]?: Listener<K>[] } = {}

  constructor(private readonly opts: {
    runtime: () => ResolvedRuntime
    env: NodeJS.ProcessEnv
    logger: SidecarLogger
    spawnFn?: typeof spawn
    backoffFn?: (attempt: number) => number
    readyTimeoutMs?: number
    maxRestarts?: number
  }) {}

  get state(): SidecarState { return this._state }
  get port(): number | undefined { return this._port }

  on<K extends keyof SidecarEvents>(event: K, listener: Listener<K>): this {
    // 显式绑定到 Listener<K>[]：映射类型的泛型索引访问在 strict 下会塌缩成 never[]，
    // 直接 .push(listener) 过不了 tsc。
    const list = (this.listeners[event] ??= []) as Listener<K>[]
    list.push(listener)
    return this
  }

  private emit<K extends keyof SidecarEvents>(event: K, payload: Parameters<SidecarEvents[K]>[0]): void {
    for (const listener of (this.listeners[event] ?? []) as (() => void)[]) (listener as (p: unknown) => void)(payload)
  }

  private setState(state: SidecarState): void {
    if (this._state === state) return
    this._state = state
    this.emit('statechange', state)
  }

  start(): void {
    this.stopping = false
    this.spawnSidecar()
  }

  retry(): void {
    if (this._state !== 'failed') return
    this.restarts = 0
    this.start()
  }

  /**
   * "重启生效"（设计书 §7）：装完插件后 sidecar 处于 ready，retry() 是 no-op——
   * 必须走本方法：终止当前 child 并等待 exit，复位计数后重新 spawn（新端口）。
   */
  async restart(): Promise<void> {
    if (this._state === 'failed') {
      this.restarts = 0
      this.start()
      return
    }
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.stopping = true // 旧 child 的 exit 不触发 crashed/退避
    if (this.child !== undefined) await killSidecar(this.child, process.platform)
    this.child = undefined
    this._port = undefined
    this.stopping = false
    this.restarts = 0
    this.spawnSidecar()
  }

  async stop(): Promise<void> {
    this.stopping = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    if (this.child !== undefined) await killSidecar(this.child, process.platform)
    this.child = undefined
    this._port = undefined
    this.setState('idle')
  }

  private spawnSidecar(): void {
    const { command, args, cwd } = this.opts.runtime()
    this.opts.logger.rotateSync()
    const child = (this.opts.spawnFn ?? spawn)(command, args, { cwd, env: this.opts.env, stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    this._port = undefined
    this.setState('spawning')

    const feed = (stream: NodeJS.ReadableStream): void => {
      createInterface({ input: stream }).on('line', (line) => {
        this.opts.logger.appendLine(line)
        const port = parseReadyPort(line)
        if (port !== undefined && this._state === 'spawning') {
          this._port = port
          this.restarts = 0
          this.setState('ready')
          this.emit('ready', port)
        }
      })
    }
    feed(child.stdout!)
    feed(child.stderr!)

    const readyTimer = this.timer = setTimeout(() => {
      if (this._state !== 'spawning') return
      // 超时判死：先 detach，kill 引发的 exit 走"非当前 child"分支，
      // 不被 exit 处理器当成崩溃重启——超时的语义是 failed，不是 crashed+重启。
      this.child = undefined
      void killSidecar(child, process.platform).then(() => this.setState('failed'))
    }, this.opts.readyTimeoutMs ?? 30_000)

    child.once('exit', () => {
      // 只清本 child 自己的计时器：旧 child 的 exit 可能晚于 restart() 后的新一轮 spawn，
      // 误清新 ready 计时器会让新一轮失去超时保护。
      clearTimeout(readyTimer)
      if (this.stopping || this.child !== child) return
      this.child = undefined
      this.setState('crashed')
      this.restarts += 1
      if (this.restarts > (this.opts.maxRestarts ?? 3)) {
        this.setState('failed')
        return
      }
      this.timer = setTimeout(() => { if (!this.stopping) this.spawnSidecar() }, (this.opts.backoffFn ?? backoffDelayMs)(this.restarts))
    })
  }
}
