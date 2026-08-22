/**
 * 运行期插件健康轮询（boot 成功后）：经 host 的 pluginInventory 远程网关读 Loader
 * 树当前 fiber 状态，交 PluginGuard.considerRuntime 处置。零 electron 依赖。
 *
 * 协议（gateway/rpc-host 源码实锚）：POST /api/pluginInventory/list，method 为斜杠两段式
 * 'pluginInventory/list'（gateway 只认两段端点；点式 host.describe 走的是 apiproxy 兜底
 * 层，不适用此处），payload 必须恰一个 args 键，content-type 必须 application/json；
 * 响应 {type:'server-response', result:{ok, value:{entries}}}。
 */

export interface RuntimeInventoryEntry {
  entryId: string
  moduleName: string
  enabled: boolean
  fiberPhase: string | null
}

export interface PluginRuntimeMonitorOpts {
  /** sidecar 当前端口（每次重启变化；undefined 时本 tick 跳过）。 */
  port: () => number | undefined
  /** 轮询间隔，默认 30s。 */
  intervalMs?: number
  /** 测试注入；生产用全局 fetch。 */
  fetchImpl?: typeof fetch
  /** 每个 tick 的全量清单回调（含空清单）。 */
  onInventory: (entries: readonly RuntimeInventoryEntry[]) => void
  /** 网络/协议错误（吞掉但留痕，不影响下一轮）。 */
  onError?: (error: unknown) => void
}

export class PluginRuntimeMonitor {
  private timer: NodeJS.Timeout | undefined
  private inFlight = false
  private rpcSeq = 0

  constructor(private readonly opts: PluginRuntimeMonitorOpts) {}

  /** 幂等：重复 start（每次 ready 都会调）先清旧 interval，杜绝双定时器。 */
  start(): void {
    this.stop()
    this.timer = setInterval(() => { void this.tick() }, this.opts.intervalMs ?? 30_000)
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** 单次拉取。重入护栏（interval 与手动 tick 并发时后到者直接放弃）；挂起连接 10s 超时。 */
  async tick(): Promise<void> {
    if (this.inFlight) return
    this.inFlight = true
    try {
      const port = this.opts.port()
      if (port === undefined) return
      const fetchImpl = this.opts.fetchImpl ?? fetch
      const res = await fetchImpl(`http://127.0.0.1:${port}/api/pluginInventory/list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: `plugin-guard-${++this.rpcSeq}`, method: 'pluginInventory/list', payload: { args: {} } }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) {
        this.safeOnError(new Error(`pluginInventory/list HTTP ${String(res.status)}`))
        return
      }
      const body = await res.json() as { result?: { ok?: boolean; value?: { entries?: unknown } } }
      const result = body.result
      if (result === undefined || result.ok !== true || !Array.isArray(result.value?.entries)) {
        this.safeOnError(new Error('pluginInventory/list: unexpected response shape'))
        return
      }
      const entries: RuntimeInventoryEntry[] = []
      for (const raw of result.value.entries) {
        if (raw === null || typeof raw !== 'object') continue
        const e = raw as Record<string, unknown>
        if (typeof e.entryId !== 'string' || typeof e.moduleName !== 'string' || typeof e.enabled !== 'boolean') continue
        entries.push({ entryId: e.entryId, moduleName: e.moduleName, enabled: e.enabled, fiberPhase: typeof e.fiberPhase === 'string' ? e.fiberPhase : null })
      }
      this.opts.onInventory(entries)
    } catch (error) {
      this.safeOnError(error)
    } finally {
      this.inFlight = false
    }
  }

  /** onError 自身故障（如日志写入失败）不得经 void tick() 变成 unhandled rejection。 */
  private safeOnError(error: unknown): void {
    try {
      this.opts.onError?.(error)
    } catch {
      /* 双故障场景：无处可报，静默 */ 
    }
  }
}
