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
  /** 超时判死路径已发出、尚未等到 exit 的 kill。stop()/restart() 要等它落地，避免新旧 sidecar 并存。 */
  private terminating: Promise<void> | undefined
  private restarts = 0
  private stopping = false
  /**
   * 单调递增的轮次号：每次 spawnSidecar() 与 stop()/restart() 各推进一次。
   * 超时落死的 .then、ready 行的接受、退避回调都捕获各自创建时的轮次，
   * 轮次已过（被 stop/restart/新一轮 spawn 接管）时不得再翻转状态或再 spawn——
   * 否则 stop 后终局的 idle 会被迟到的 failed 覆盖、restart 新一轮会被旧轮落死卡死。
   */
  private epoch = 0
  /** stop()/restart() 串行链：await killSidecar 的挂起点上并发调用不得交错（孤儿 child / 撤销 stop）。 */
  private ops: Promise<void> = Promise.resolve()
  /** 进行中的 restart：重叠调用合并为同一次"杀旧+换新"，保证恰好拉起一个新 child。 */
  private inflightRestart: Promise<void> | undefined
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
    // start 也走串行链：在飞行 stop()/restart() 的 kill→exit 窗口里直接 spawn，
    // 会产出"状态被落定的 stop 覆盖成 idle、却留着活 child"的孤儿
    // （无超时保护、ready 行被拒、下一次 start 再孤儿化它）。
    // 同步入口拿不到 Promise：链自身吞错续跑，这里再兜一层 catch 避免 unhandled rejection。
    this.runSerialized(() => this.doStart()).catch(() => {})
  }

  retry(): void {
    // failed-only 守卫放在串行 op 内：与在飞行 stop() 竞争时，守卫看到的是
    // stop 落定后的终态（idle），不会在其 kill 窗口里抢先 spawn 出 stop 管不到的 child。
    this.runSerialized(() => this.doRetry()).catch(() => {})
  }

  /**
   * "重启生效"（设计书 §7）：装完插件后 sidecar 处于 ready，retry() 是 no-op——
   * 必须走本方法：终止当前 child 并等待 exit，复位计数后重新 spawn（新端口）。
   * stop() 之后的 restart 是明确的用户意图，等同全新 start。重叠调用合并为一次。
   */
  restart(): Promise<void> {
    if (this.inflightRestart === undefined) {
      this.inflightRestart = this.runSerialized(() => this.doRestart())
    }
    return this.inflightRestart
  }

  /** 停止是终局：idle、不重启；旧一轮迟到的落死/退避/ready 不得再翻转状态。 */
  stop(): Promise<void> {
    return this.runSerialized(() => this.doStop())
  }

  /** 把 op 排到串行链上执行（FIFO）；链吞掉前序失败，调用方拿到自己这次 op 的结果。 */
  private runSerialized(op: () => Promise<void>): Promise<void> {
    const next = this.ops.then(op, op)
    this.ops = next.then(() => {}, () => {})
    return next
  }

  private async doRestart(): Promise<void> {
    try {
      // stop() 之后 / failed 之下的 restart 与 start/retry 殊途同归：
      // 统一走 doStart（有 child 或在途 kill 时先终止等完，再按全新一轮拉起）。
      await this.doStart()
    } finally {
      // 同步清掉（在 promise settle 之前）：await 完成后紧接的 restart 是新一轮，不得被合并掉。
      this.inflightRestart = undefined
    }
  }

  /** retry 的串行 op：守卫在链内（状态已落定）判定，failed-only。 */
  private async doRetry(): Promise<void> {
    if (this._state !== 'failed') return
    await this.doStart()
  }

  /**
   * 全新一轮的统一实现（start/retry/restart 三入口）。
   * 有 child 或在途 kill：先终止并等 exit，旧一轮的超时落死/退避/ready 随 epoch+1 全部失效；
   * 否则直接拉起。两种路径都清零预算、复位 stopping（覆盖 stop() 留下的终局标记）。
   */
  private async doStart(): Promise<void> {
    if (this.child !== undefined || this.terminating !== undefined) {
      this.epoch += 1 // 旧一轮的超时落死/退避/ready 全部失效
      this.stopping = true // 旧 child 的 exit 不触发 crashed/退避
      this.clearTimer()
      await this.terminateCurrent()
    }
    this._port = undefined
    this.stopping = false
    this.restarts = 0 // 上一轮 failed 耗尽的预算不得带进新一轮
    this.spawnSidecar()
  }

  private async doStop(): Promise<void> {
    this.epoch += 1 // 旧一轮的一切后续（超时落死、退避、ready）失效
    this.stopping = true
    this.clearTimer()
    await this.terminateCurrent()
    this._port = undefined
    this.restarts = 0
    this.setState('idle')
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** 杀当前 child 并等 exit；超时判死已 detach 的在途 kill 也一并等完——返回时旧进程确已终止。 */
  private async terminateCurrent(): Promise<void> {
    if (this.child !== undefined) {
      const old = this.child
      this.child = undefined
      await killSidecar(old, process.platform)
    } else if (this.terminating !== undefined) {
      await this.terminating
    }
    this.terminating = undefined
  }

  private spawnSidecar(): void {
    const { command, args, cwd } = this.opts.runtime()
    this.opts.logger.rotateSync()
    const child = (this.opts.spawnFn ?? spawn)(command, args, { cwd, env: this.opts.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const epoch = ++this.epoch
    this.child = child
    this._port = undefined
    this.setState('spawning')

    let timedOut = false // 本轮超时判死后不再接受 ready 行：垂死 child 不得报"已连上"

    const feed = (stream: NodeJS.ReadableStream): void => {
      createInterface({ input: stream }).on('line', (line) => {
        this.opts.logger.appendLine(line)
        const port = parseReadyPort(line)
        // 只有"当前轮次、未判死"的 child 才能宣布 ready：旧 child 迟到的端口行
        // （restart 后才 flush 出来）不得污染新一轮的端口与 ready 事件。
        if (port !== undefined && this._state === 'spawning' && epoch === this.epoch && !timedOut) {
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
      if (this._state !== 'spawning' || epoch !== this.epoch) return
      timedOut = true
      // 超时判死：先 detach，kill 引起的 exit 走"非当前 child"分支，
      // 不被 exit 处理器当成崩溃重启——超时的语义是 failed，不是 crashed+重启。
      this.child = undefined
      this.terminating = killSidecar(child, process.platform)
      void this.terminating.then(() => {
        // 等到 exit 时轮次可能已被 stop()/restart() 接管：迟到的落死不得把
        // stop 后的 idle / restart 新一轮的 spawning 改成 failed（并孤儿化新 child）。
        if (epoch === this.epoch) this.setState('failed')
      })
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
      this.timer = setTimeout(() => {
        // 已触发但尚未出队的退避回调（clearTimeout 追不上）由轮次号拦截，避免双 spawn。
        if (this.stopping || epoch !== this.epoch) return
        this.spawnSidecar()
      }, (this.opts.backoffFn ?? backoffDelayMs)(this.restarts))
    })
  }
}
