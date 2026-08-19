/**
 * 断链 profile bundle 自愈（事故兜底，非功能演进）。
 *
 * 事故事实（2026-08-18 用户实机）：插件更新途中 pnpm 被打断（应用退出/重启撞上
 * 安装，或 Windows 文件锁致 pnpm 异常退出），留下「dsh.profile.bundles 声明了包、
 * node_modules 里目录为空」的断链态——dsh-app-boot 的 resolveBundleDir 在组合期
 * 直接抛错，sidecar 进入崩溃循环，任何插件（包括安装器自己）都加载不上，只有
 * 壳层能修。修复动作本身被证明是幂等的：重跑一次 `dsh plugin add <name>@<钉住
 * 版本>`（同 seedBundle 路径，实测 488ms 补齐 node_modules）。
 *
 * 特征行是 dsh-app-boot 的英文报错（ASCII，不受 GBK 影响）；只修 profile 依赖里
 * 声明过的社区插件——@deepseek-ai 安装级包缺件是另一类问题（electron-builder
 * 打包缺口），往 profile 里补装会掩盖真因，一律不动。
 */

/** dsh-app-boot resolveBundleDir 的报错行（崩溃循环里会反复出现，取最后一次）。 */
const BUNDLE_BRICK_RE = /cannot resolve profile bundle "([^"]+)"/g

/** 从 sidecar 日志提取断链的包名；无特征时为 null。 */
export function bundleBrickName(logText: string): string | null {
  let last: string | null = null
  for (const match of logText.matchAll(BUNDLE_BRICK_RE)) last = match[1] ?? last
  return last
}

/**
 * 由 profile package.json 推导修复规格：依赖里有钉住的版本 → `name@版本`（恢复
 * 最后已知可用态；更新意图作废，用户可在安装页重试）；bundles 声明过但依赖行
 * 丢了 → 裸 name（按 latest 重装并 reconcile），仅限非 scope 包——@deepseek-ai
 * 安装级包缺件是另一类问题（electron-builder 打包缺口），往 profile 里补装会
 * 掩盖真因；两者皆无（安装级包/陌生名字/文件损坏）→ null，不修。
 */
export function repairSpecFromManifest(manifestText: string, name: string): string | null {
  let parsed: {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: unknown } }
  }
  try {
    parsed = JSON.parse(manifestText) as typeof parsed
  } catch {
    return null
  }
  const pinned = parsed.dependencies?.[name]
  if (typeof pinned === 'string' && pinned !== '') return `${name}@${pinned}`
  if (!name.startsWith('@')) {
    const bundles = parsed.dsh?.profile?.bundles
    if (Array.isArray(bundles) && bundles.includes(name)) return name
  }
  return null
}

/** 一个断链包在本进程内的处置状态。 */
type NameState = 'started' | 'done' | 'failed'

/** 自愈器编排：单飞（崩溃循环会高频触发）、每名至多尝试一次、总量限额。
 *
 * 2026-08-19 用户实机事故教训：断链崩溃循环里自愈一次都没触发，且四份轮转
 * 日志零痕迹——所有放弃路径此前都是静默的，事后无法定位是哪一环退出。现在
 * 每个有意义的放弃路径都留一次性日志；日志写出失败被吞掉（日志永远不能阻断
 * 自愈）；repair 同步抛错会复位单飞标志；failed 终态时对「修复失败过」的包
 * 再给一次机会（预算仍封顶）。 */
export class BundleBrickHealer {
  private inflight = false
  private repairs = 0
  private readonly names = new Map<string, NameState>()
  private readonly loggedOnce = new Set<string>()

  constructor(private readonly opts: {
    /** 当前 sidecar 日志全文；读失败返回 null。 */
    readLog: () => string | null
    /** profile package.json 文本；读失败返回 null。 */
    readManifest: () => string | null
    /** 执行修复（name, spec），返回退出码。 */
    repair: (name: string, spec: string) => Promise<number>
    log: (line: string) => void
    /** 修复成功后回调（壳层在 failed 终态时显式拉起）。 */
    onRepaired: () => void
    /** 进程级修复总量上限，默认 3。 */
    maxRepairs?: number
  }) {}

  /** 日志是取证生命线，但写日志失败绝不能反过来打断自愈。 */
  private safeLog(line: string): void {
    try { this.opts.log(line) } catch { /* logging must never break healing */ }
  }

  private logOnce(key: string, line: string): void {
    if (this.loggedOnce.has(key)) return
    this.loggedOnce.add(key)
    this.safeLog(line)
  }

  /**
   * 喂一次崩溃现场：命中特征且允许时启动异步修复。修复期间（数秒到数十秒，
   * 管理器的退避重启会自行耗尽预算落到 failed）重复调用是 no-op；成功后若
   * 仍在 failed，由 onRepaired 拉起新一轮。terminal 对应管理器放弃重启的
   * 终态——此时对修复失败过的包再尝试一次（仍受总量限额约束）。
   */
  consider(opts: { terminal?: boolean } = {}): boolean {
    if (this.inflight) return false
    if (this.repairs >= (this.opts.maxRepairs ?? 3)) {
      this.logOnce('budget', `repair budget exhausted (${this.repairs}); leaving the failure page up`)
      return false
    }
    let logText: string | null = null
    try { logText = this.opts.readLog() } catch { logText = null }
    if (logText === null) {
      this.logOnce('read-log', 'sidecar log unreadable; cannot look for a brick signature')
      return false
    }
    const name = bundleBrickName(logText)
    if (name === null) return false
    const state = this.names.get(name)
    if (state === 'started' || state === 'done' || (state === 'failed' && opts.terminal !== true)) {
      if (opts.terminal === true && state !== 'started') {
        this.logOnce(`still:${name}`, `profile bundle "${name}" still unresolvable after its repair attempt; leaving it to the failure page`)
      }
      return false
    }
    let manifest: string | null = null
    try { manifest = this.opts.readManifest() } catch { manifest = null }
    if (manifest === null) {
      this.logOnce('read-manifest', 'profile manifest unreadable; cannot derive a repair spec')
      return false
    }
    const spec = repairSpecFromManifest(manifest, name)
    if (spec === null) {
      // 只记一次：崩溃循环会反复喂同一段日志。
      this.logOnce(`foreign:${name}`, `profile bundle "${name}" unresolvable but not declared in the profile; leaving it to the failure page`)
      this.names.set(name, 'done')
      return false
    }
    this.inflight = true
    this.repairs += 1
    this.names.set(name, 'started')
    this.safeLog(`profile bundle "${name}" unresolvable; repairing with ${spec}`)
    let promise: Promise<number>
    try {
      promise = this.opts.repair(name, spec)
    } catch (error) {
      this.inflight = false
      this.names.set(name, 'failed')
      this.safeLog(`repair of "${name}" threw: ${String(error)}`)
      return true
    }
    void promise.then((code) => {
      this.inflight = false
      if (code === 0) {
        this.names.set(name, 'done')
        this.safeLog(`repair of "${name}" succeeded; restarting if failed`)
        this.safeOnRepaired()
      } else {
        this.names.set(name, 'failed')
        this.safeLog(`repair of "${name}" failed (exit ${code}); will retry once more if the sidecar gives up`)
      }
    }, (error: unknown) => {
      this.inflight = false
      this.names.set(name, 'failed')
      this.safeLog(`repair of "${name}" threw: ${String(error)}`)
    })
    return true
  }

  private safeOnRepaired(): void {
    try { this.opts.onRepaired() } catch { /* shell restart is best-effort here */ }
  }
}
