import { basename, join, sep } from 'node:path'
import { bundleNameOfRowSource, findDuplicateEntryIds, findDuplicateNames, isBundleRow, readLayerTable, userDomainRowIds, type LayerTable } from './patch-layers'
import { diagnoseLog, RE_CONFLICT_DETAIL, type GuardCategory, type GuardFinding } from './guard-diagnose'
import { disabledEntryIds, quarantineBundles, quarantineEntries, repairCorruptLayers, removeQuarantine } from './guard-quarantine'
import { GuardLedgerStore } from './guard-ledger'

export interface PluginGuardOpts {
  dshHome: string
  /** 读 sidecar 当前日志全文（崩溃诊断与 ready 态巡检的输入）；不可用时返回 null。 */
  readLog: () => string | null
  log: (line: string) => void
  profile?: string
  /** 单进程累计隔离动作（行 + bundle）上限，防无限循环。默认 8。 */
  maxQuarantined?: number
  /** 台账新增条目回调（ready 态运行期隔离的用户可见通知入口；自身抛错被吞掉）。 */
  onNewFindings?: (added: GuardFinding[]) => void
}

const nowIso = (): string => new Date().toISOString()

/** 无可定位诊断的失败连续达到此次数 → 进入安全模式（一次性全量停用 tracked 插件）。 */
const SAFE_MODE_AFTER = 2

/**
 * 环境级 spawn 故障（可执行文件缺失/被锁等）不是插件问题：不计连击（也不清零，保持现状）。
 * 只认 spawn 系错误码与 spawn 抛错形态；裸 EACCES 常见于插件级文件权限错误，不得整体豁免。
 */
const SPAWN_ERROR_RE = /Error: spawn\w*\b|spawn\w*(?: [\w@/.-]+)? (?:ENOENT|EACCES|EPERM)\b/

/**
 * 渲染器客户端插件树 boot 失败的签名门（AppWebEntry boot.tsx 只把失败 console.error 到
 * 浏览器；文案与宿主共用同一 vendored loader）。'config reload at' 属宿主 HMR 噪声，
 * 不在此门（归 patrol 巡检）。
 */
const CLIENT_BOOT_SIG_RE = /failed to (?:import|apply) loader entry|did not activate|web boot:|loader fibers failed|already has locale/

/**
 * name 优先解析 finding 的隔离目标行 id。客户端树的 entry id 每次页面加载随机生成
 * （Math.random hex）、无 id 的 insert 行每次 boot 随机 ensureId——都与宿主 patch 行 id
 * 不同空间，直接写 disable 行是惰性空操作（include 只 warn entry not found）。必须换成
 * 宿主行 id；同名行全部停用（任何一份拷贝重新挂载都会复现冲突）。id 本身就在层表
 * （宿主侧崩溃路径）则原样使用。解析不到 → undefined（调用方转 report-only）。
 */
function resolveHostRowIds(table: LayerTable, finding: Pick<GuardFinding, 'id' | 'name'>): string[] | undefined {
  if (finding.name !== undefined && finding.name !== '') {
    const ids = table.idsByName.get(finding.name)
    if (ids !== undefined && ids.length > 0) return ids
  }
  if (finding.id !== undefined && table.rows.some(row => row.id === finding.id)) return [finding.id]
  return undefined
}

/** detail 命中单占用资源被重复注册特征（locale ns/槽位/服务/命令）时归类冲突。 */
function classifyDetail(detail: string, fallback: GuardCategory): GuardCategory {
  return RE_CONFLICT_DETAIL.test(detail) ? 'conflict' : fallback
}

/**
 * 重复 entry id 的处置：层叠顺序保留首个声明，其余行按来源 bundle 移出 bundles 清单。
 * 裸行 disable 无法消除重复（两行 insert 仍都在树上、group 查重照样抛错），必须整层移除；
 * 用户层来源或模板 bundle 无法安全处理 → 仅报告。只动 tracked（用户安装级）bundle。
 */
function resolveDuplicate(table: LayerTable, dupId: string): { removeBundles: string[]; handled: boolean } {
  const rows = table.rows.filter(row => row.id === dupId)
  const tracked = new Set(table.tracked)
  const removeBundles: string[] = []
  for (const row of rows.slice(1)) {
    if (!isBundleRow(row.source)) continue
    const bundle = bundleNameOfRowSource(row.source)
    if (bundle !== undefined && tracked.has(bundle) && !removeBundles.includes(bundle)) removeBundles.push(bundle)
  }
  return { removeBundles, handled: removeBundles.length > 0 }
}

/**
 * 插件守卫：启动前静态预检 + 崩溃日志诊断 → 自动隔离问题插件 → 台账与弹窗报告。
 * 与 skin/bundle 两个自愈器并列挂在 sidecar statechange 上；本类不 import electron。
 * 所有公共方法吞掉自身异常并留痕（2026-08-19 自愈零痕迹事故的教训），绝不阻断启动链。
 */
export class PluginGuard {
  private readonly ledger: GuardLedgerStore
  private quarantined = 0
  /** 连续「无可定位诊断」的崩溃轮数（有可动作发现或有新动作即清零）。 */
  private emptyDiagnosisStreak = 0
  private safeModeTried = false
  /** 运行期连续 fiberPhase=null 的条目（entryId → 连击数；≥2 记账）。 */
  private readonly nullFiberStreaks = new Map<string, number>()
  /**
   * ready 态日志巡检窗口：每轮重扫日志末尾这一段（而非纯增量偏移——live-apply 失败行
   * 只出现一次，增量模式下「两轮确认」永远凑不齐第二轮）。窗口内的行会被重复解析，
   * 台账按 key 去重、动作由两轮确认门控，重扫无副作用；失败行被后续输出推出窗口仍未
   * 确认 = 视为瞬态放行（下次重启由崩溃路径兜底）。
   */
  private static readonly PATROL_WINDOW = 16_000
  /** patrol 上一轮窗口内出现过的可动作 key（两轮确认，滤掉 live watch 半写瞬态）。 */
  private patrolActionablePrev = new Set<string>()

  constructor(private readonly opts: PluginGuardOpts) {
    this.ledger = new GuardLedgerStore(join(opts.dshHome, 'plugin-guard.json'))
  }

  /** 启动前静态预检（sidecar 未起、fs.watch 句柄不存在的安全窗口）。 */
  preBoot(): void {
    try {
      const table = readLayerTable({ dshHome: this.opts.dshHome, profile: this.opts.profile })
      const findings: GuardFinding[] = []
      const removeBundles: string[] = []
      const repairPaths: string[] = []
      const entryIds: string[] = []
      const tracked = new Set(table.tracked)
      for (const corrupt of table.corruptLayers) {
        if (corrupt.bundle !== undefined && tracked.has(corrupt.bundle)) {
          removeBundles.push(corrupt.bundle)
          findings.push({ key: `bundle:${corrupt.bundle}`, kind: 'bundle', bundle: corrupt.bundle, category: 'config-corrupt', reason: `插件包 ${corrupt.bundle} 的补丁层无法解析，已将其移出本次启动清单（原清单已备份）`, source: 'pre-boot', firstSeen: nowIso() })
        } else if (corrupt.bundle !== undefined) {
          findings.push({ key: `bundle:${corrupt.bundle}`, kind: 'bundle', bundle: corrupt.bundle, category: 'config-corrupt', reason: `插件包 ${corrupt.bundle} 的补丁层无法解析（系统级包，未自动移除）`, source: 'pre-boot', firstSeen: nowIso() })
        } else if (basename(corrupt.path) === 'cordis.patch.yml') {
          repairPaths.push(corrupt.path)
          findings.push({ key: `file:${corrupt.path}`, kind: 'file', path: corrupt.path, category: 'config-corrupt', reason: `补丁层无法解析，已备份原文件并重置：${corrupt.path}`, source: 'pre-boot', firstSeen: nowIso() })
        } else {
          findings.push({ key: `file:${corrupt.path}`, kind: 'file', path: corrupt.path, category: 'config-corrupt', reason: `文件无法解析（未自动修改）：${corrupt.path}`, source: 'pre-boot', firstSeen: nowIso() })
        }
      }
      for (const dupId of findDuplicateEntryIds(table)) {
        const { removeBundles: bundles, handled } = resolveDuplicate(table, dupId)
        removeBundles.push(...bundles)
        findings.push({
          key: `entry:${dupId}`, kind: 'entry', id: dupId, category: 'conflict',
          reason: handled
            ? `entry id 重复（${dupId}），已移出后声明的插件包：${bundles.join('、')}`
            : `entry id 重复（${dupId}），来源无法自动处理，请卸载其中一个重复插件`,
          source: 'pre-boot', firstSeen: nowIso(),
        })
      }
      // 同名不同 id 的重复组合：loader 的 group 只查重 id、对同 name 双行照单全收，但双行
      // = 同模块双 apply（服务/locale 命名空间冲突的温床，客户端树虽按 name 去重、宿主侧
      // 仍双挂）。行级停用后声明行即可解除（与 id 重复不同：那里裸行无效、必须整层移除）；
      // 只动用户域行（tracked bundle 行或用户层行），模板/系统行仅报告。裸行覆盖（含守卫
      // 自己的历史隔离行）与 insert 自带 disabled 的行不算活行，不参与查重。
      const overrides = disabledEntryIds({ dshHome: this.opts.dshHome })
      for (const name of findDuplicateNames(table, overrides)) {
        const live = table.rows.filter(row => row.name === name && !row.disabled && !overrides.has(row.id))
        const laterIds: string[] = []
        let skippedSystem = false
        for (const row of live.slice(1)) {
          if (isBundleRow(row.source)) {
            const bundle = bundleNameOfRowSource(row.source)
            if (bundle === undefined || !tracked.has(bundle)) { skippedSystem = true; continue }
          }
          laterIds.push(row.id)
        }
        entryIds.push(...laterIds)
        findings.push({
          key: `name:${name}`, kind: 'entry', id: live[0]?.id, name, category: 'conflict',
          reason: laterIds.length > 0
            ? `同一插件（${name}）被组合了 ${live.length} 次，已停用后声明的 ${laterIds.length} 行（首行保留生效）`
            : `同一插件（${name}）被组合了 ${live.length} 次（重复来源为系统级组合行，未自动停用），请卸载重复安装的插件`,
          source: 'pre-boot', firstSeen: nowIso(),
        })
        if (skippedSystem && laterIds.length === 0) this.opts.log(`plugin guard: duplicate name ${name} involves system rows; report-only`)
      }
      for (const name of table.missingBundles) {
        findings.push({ key: `bundle:${name}`, kind: 'bundle', bundle: name, category: 'dependency-missing', reason: `bundle 缺件（本次启动会被跳过，可尝试在插件页重装）：${name}`, source: 'pre-boot', firstSeen: nowIso() })
      }
      // 半安装残骸（入口文件缺失）：row.name 命中该包名的行 import 必炸（hoisted linker
      // 下确定性解析到残缺入口），直接预隔离省一轮崩溃循环；同 spec 重装不恢复，修复
      // 必须先卸载再装。bundle patch 内 name 不同的行不动（目标模块在别处，非必然受害）。
      const brokenRowIds = new Set<string>()
      for (const name of table.brokenBundles) {
        findings.push({ key: `bundle:${name}`, kind: 'bundle', bundle: name, category: 'dependency-missing', reason: `插件包 ${name} 残缺（入口文件缺失），相关插件已预先停用；请先卸载再重装该插件`, source: 'pre-boot', firstSeen: nowIso() })
        for (const row of table.rows) {
          if (row.name === name) brokenRowIds.add(row.id)
        }
      }
      entryIds.push(...brokenRowIds)
      this.apply(findings, { entryIds, removeBundles, repairPaths })
    } catch (error) {
      this.opts.log(`plugin guard pre-boot threw: ${String(error)}`)
    }
  }

  /**
   * 崩溃诊断（crashed/failed 时调用，与既有自愈器并列）。读日志 → 签名诊断 → 隔离。
   * 返回是否执行了新的隔离动作；true 且当前 failed 时调用方应显式 restart（预算随之清零）。
   * 无可定位诊断的失败连续 SAFE_MODE_AFTER 轮 → 安全模式（一次性停用全部 tracked 插件，
   * 兜住原生崩溃/启动死循环这类日志无签名的场景）；安全模式后仍失败 → 环境问题报告。
   */
  considerCrash(_opts: { terminal: boolean }): { quarantinedNew: boolean } {
    try {
      const text = this.opts.readLog()
      if (text === null) return { quarantinedNew: false } // 日志不可读：不算证据，不计数
      const table = readLayerTable({ dshHome: this.opts.dshHome, profile: this.opts.profile })
      const findings = text === '' ? [] : diagnoseLog(text, table)
      let suppressedByBudget = false
      if (findings.length > 0) {
        const disabled = disabledEntryIds({ dshHome: this.opts.dshHome })
        const tracked = new Set(table.tracked)
        const entryIds = new Set<string>()
        const removeBundles = new Set<string>()
        const repairPaths = new Set<string>()
        for (const finding of findings) {
          if (finding.kind === 'entry' && finding.id !== undefined && !disabled.has(finding.id)) {
            if (finding.key.startsWith('service:')) {
              // 服务重复注册：隔离该 entry 本身即可解除冲突。
              entryIds.add(finding.id)
            } else if (finding.category === 'conflict') {
              // duplicate loader entry id：裸行无效，走 bundle 移除（见 resolveDuplicate）。
              const { removeBundles: bundles } = resolveDuplicate(table, finding.id)
              for (const bundle of bundles) removeBundles.add(bundle)
            } else {
              entryIds.add(finding.id)
            }
          } else if (finding.kind === 'file' && finding.path !== undefined) {
            if (finding.path.includes(`${sep}node_modules${sep}`)) {
              // 插件包内补丁层损坏 → 移出 bundle（仅用户安装级）。
              const bundle = bundleNameOfRowSource(finding.path)
              if (bundle !== undefined && tracked.has(bundle)) removeBundles.add(bundle)
            } else if (basename(finding.path) === 'cordis.patch.yml') {
              repairPaths.add(finding.path)
            }
          }
        }
        // 移出的 bundle 在台账里以「插件包」口径呈现（file 路径只是技术细节），
        // 与 preBoot 的 config-corrupt 文案一致；同 key 已有记录则不重复。
        const reportFindings = [...findings]
        for (const name of removeBundles) {
          if (!reportFindings.some(f => f.key === `bundle:${name}`)) {
            reportFindings.push({ key: `bundle:${name}`, kind: 'bundle', bundle: name, category: 'config-corrupt', reason: `插件包 ${name} 的补丁层无法解析，已将其移出本次启动清单（原清单已备份）`, source: 'crash', firstSeen: nowIso() })
          }
        }
        const { acted, suppressedByBudget: suppressed } = this.apply(reportFindings, {
          entryIds: [...entryIds],
          removeBundles: [...removeBundles],
          repairPaths: [...repairPaths],
        })
        if (acted) {
          this.emptyDiagnosisStreak = 0
          return { quarantinedNew: true }
        }
        suppressedByBudget = suppressed
      }
      // 连击计数：本轮既无可动作发现（entry/bundle 类）、无新隔离动作、也非环境级
      // spawn 故障，才视为一次「无证据失败」。boot:include（kind=service）之类的报告
      // 轮不计——AggregateError 多失败恰好只产出它，必须让连击走下去才能进安全模式；
      // 但「有可动作发现、却因隔离预算耗尽写不了行」必须计（否则 >8 个并发失败会
      // 既不隔离也不进安全模式，死锁在 failed 终态）。空发现轮（日志无签名）是安全
      // 模式的主入口，连击必须照走。触发检查收在增量分支内：安全模式后的「有发现但
      // 无动作」轮不误报环境问题。
      const actionable = findings.some(f => f.kind === 'entry' || f.kind === 'bundle')
      if ((!actionable || suppressedByBudget) && !SPAWN_ERROR_RE.test(text.slice(-500))) {
        this.emptyDiagnosisStreak += 1
        if (this.emptyDiagnosisStreak >= SAFE_MODE_AFTER) {
          if (!this.safeModeTried) {
            this.safeModeTried = true
            if (this.enterSafeMode(table)) return { quarantinedNew: true }
          } else {
            this.recordEnvironmentFinding()
          }
        }
      }
      return { quarantinedNew: false }
    } catch (error) {
      this.opts.log(`plugin guard crash-diagnosis threw: ${String(error)}`)
      return { quarantinedNew: false }
    }
  }

  /**
   * 安全模式：一次性停用全部 tracked bundle 行 + profile/home 用户层行（排除已停用；
   * 模板/系统 bundle 行绝不动——dsh-base/web-app 必须活着应用才能起）。直调隔离写入、
   * 不走 apply 也不递增 quarantined 预算（一次有界动作，不能吃满后续运行期监测的额度）。
   * 台账记一条聚合 finding（boot:safe-mode）；返回是否真的写入了新行。
   */
  private enterSafeMode(table: LayerTable): boolean {
    const disabled = disabledEntryIds({ dshHome: this.opts.dshHome })
    const ids = new Set(userDomainRowIds(table).filter(id => !disabled.has(id)))
    let written: string[] = []
    if (ids.size > 0) {
      try {
        written = quarantineEntries({ dshHome: this.opts.dshHome, ids: [...ids] }).written
      } catch (error) {
        this.opts.log(`plugin guard safe-mode quarantine threw: ${String(error)}`)
      }
    }
    // 名单只报真正写入的行：写失败/全已停用时不得虚报停用名单。
    const writtenSet = new Set(written)
    const names = table.rows.filter(row => writtenSet.has(row.id)).map(row => row.name || row.id)
    try {
      this.ledger.record([{
        key: 'boot:safe-mode', kind: 'service', category: 'safe-mode',
        reason: written.length === 0
          ? '已尝试进入安全模式，但没有可停用的插件条目（可能已全部停用）；若仍无法启动，问题疑似不在插件，详见日志目录中的 sidecar.log。'
          : `连续多次启动失败且日志中无可定位的插件签名，已进入安全模式：停用 ${names.length} 个已安装插件（${names.join('、').slice(0, 200)}）。可从托盘「插件隔离报告」一键重新启用；若怀疑误判，请先重装最近新装的插件再试。`,
        source: 'crash', firstSeen: nowIso(),
      }])
    } catch (error) {
      this.opts.log(`plugin guard ledger threw: ${String(error)}`)
    }
    this.opts.log(`plugin guard: safe mode engaged — stopped ${written.length} entries (${names.join(', ')})`)
    return written.length > 0
  }

  /** 安全模式后仍无诊断失败：非插件因素的最终报告（每轮合并进同一条，不重复打扰）。 */
  private recordEnvironmentFinding(): void {
    this.opts.log('plugin guard: safe mode did not recover the boot; suspect non-plugin cause')
    try {
      this.ledger.record([{
        key: 'boot:environment', kind: 'service', category: 'safe-mode',
        reason: '安全模式（全部已安装插件停用）下仍无法启动，问题疑似不在插件，详见日志目录中的 sidecar.log。',
        source: 'crash', firstSeen: nowIso(),
      }])
    } catch (error) {
      this.opts.log(`plugin guard ledger threw: ${String(error)}`)
    }
  }

  /**
   * boot 成功（ready）：无证据连击清零——成功本身证明配置可行；隔离预算同时重置——
   * 预算防的是单轮崩溃循环里的无限隔离，boot 成功即循环已破，跨会话累计只会把长会话
   * 后新故障的自动隔离饿死（reload 不触发 ready，客户端页级恢复不受影响）。
   */
  noteBootSuccess(): void {
    this.emptyDiagnosisStreak = 0
    this.quarantined = 0
  }

  /**
   * 运行期 fiber 健康处置（ready 后由 PluginRuntimeMonitor 每轮喂入全量清单）。
   * 自动停用只作用于用户域条目（tracked bundle 行或 profile/home 用户层行——与安全
   * 模式同口径）：home 层被 sidecar live watch，写行即时生效，误停 dsh-base/web-app
   * 这类核心 fiber 的代价远大于收益，系统级条目失败只记录。PENDING 一律仅记录
   * （等待是上游合法的静默状态）。
   */
  considerRuntime(entries: readonly { entryId: string; moduleName: string; enabled: boolean; fiberPhase: string | null }[]): void {
    try {
      const failed = entries.filter(e => e.enabled && e.fiberPhase === 'failed')
      const pending = entries.filter(e => e.enabled && e.fiberPhase === 'pending')
      // fiber 为 null 的 enabled 条目 = import 失败残骸或 dispose 竞态窗口（inventory 的
      // FIBER_PHASE 映射里 DISPOSED/无 fiber 都是 null）。加载瞬态一轮即逝，连续两轮
      // （60s）仍在才记账——只报告不停用（不可区分「必炸」与「正在被替换」）。
      const fiberless = entries.filter(e => e.enabled && e.fiberPhase === null)
      const fiberlessIds = new Set(fiberless.map(e => e.entryId))
      for (const id of [...this.nullFiberStreaks.keys()]) {
        if (!fiberlessIds.has(id)) this.nullFiberStreaks.delete(id)
      }
      for (const e of fiberless) {
        this.nullFiberStreaks.set(e.entryId, (this.nullFiberStreaks.get(e.entryId) ?? 0) + 1)
      }
      const fiberlessConfirmed = fiberless.filter(e => (this.nullFiberStreaks.get(e.entryId) ?? 0) >= 2)
      if (failed.length === 0 && pending.length === 0 && fiberlessConfirmed.length === 0) return
      const table = readLayerTable({ dshHome: this.opts.dshHome, profile: this.opts.profile })
      const userDomain = new Set(userDomainRowIds(table))
      const findings: GuardFinding[] = []
      const quarantineIds: string[] = []
      for (const e of failed) {
        const actionable = userDomain.has(e.entryId)
        findings.push({
          key: `runtime:${e.entryId}`, kind: 'entry', id: e.entryId, name: e.moduleName,
          category: 'plugin-error',
          // 措辞不预设写行必然成功（隔离预算耗尽时只记录不写行），以隔离报告的实际状态为准。
          reason: actionable
            ? '插件在运行期失败，已尝试自动停用（实际状态以托盘「插件隔离报告」为准）。'
            : '系统级插件在运行期失败（仅记录，未自动停用）。',
          source: 'runtime', firstSeen: nowIso(),
        })
        if (actionable) quarantineIds.push(e.entryId)
      }
      for (const e of pending) {
        findings.push({
          key: `runtime:${e.entryId}`, kind: 'entry', id: e.entryId, name: e.moduleName,
          category: 'dependency-missing', reason: '插件在运行期处于等待状态（依赖的服务未提供），已记录。',
          source: 'runtime', firstSeen: nowIso(),
        })
      }
      for (const e of fiberlessConfirmed) {
        findings.push({
          key: `runtime:${e.entryId}`, kind: 'entry', id: e.entryId, name: e.moduleName,
          category: 'plugin-error', reason: '插件条目持续无运行实例（import 失败或已销毁），已记录；若插件不工作请卸载后重装。',
          source: 'runtime', firstSeen: nowIso(),
        })
      }
      this.apply(findings, { entryIds: quarantineIds, removeBundles: [], repairPaths: [] })
    } catch (error) {
      this.opts.log(`plugin guard runtime threw: ${String(error)}`)
    }
  }

  /**
   * 渲染器客户端插件树 boot 失败诊断（主进程经 webContents console-message 喂入，仅
   * dsh 页在场时转发）。宿主对客户端树零感知——pluginInventory 只投影宿主 loader，客户端
   * 失败唯一可靠信号就是 boot.tsx console.error 的原文（与宿主共用同一 vendored loader
   * 文案，diagnoseLog 的签名直接适用）。隔离目标必须按 name 反查宿主行（客户端 entry id
   * 每页随机），解析不到就报告并明示「卸载重装」，绝不写匹配不到任何宿主行的惰性行。
   * 返回 relevant（签名命中=页面处于失败 boot）与 resolvable（至少一个 finding 定位到
   * 宿主行=reload 可恢复），调用方据此决定 reload 重试。
   */
  considerClientConsole(text: string): { relevant: boolean; acted: boolean; resolvable: boolean } {
    try {
      if (!CLIENT_BOOT_SIG_RE.test(text)) return { relevant: false, acted: false, resolvable: false }
      const table = readLayerTable({ dshHome: this.opts.dshHome, profile: this.opts.profile })
      const findings = diagnoseLog(text, table)
      if (findings.length === 0) return { relevant: true, acted: false, resolvable: false }
      const disabled = disabledEntryIds({ dshHome: this.opts.dshHome })
      const entryIds = new Set<string>()
      let resolvable = false
      const resolved: GuardFinding[] = []
      for (const finding of findings) {
        if (finding.kind !== 'entry') {
          resolved.push({ ...finding, source: 'client' })
          continue
        }
        // 台账 key 一律用稳定键（name），否则客户端随机 id 每次 reload 都是新 key：
        // 去重失效、unreported 逐轮膨胀、通知连发。
        const stableKey = `client:${finding.name ?? finding.id}`
        const hostIds = resolveHostRowIds(table, finding)
        if (hostIds === undefined) {
          resolved.push({
            ...finding, key: stableKey, id: undefined,
            category: classifyDetail(finding.reason, finding.category), source: 'client',
            reason: `客户端插件启动失败：${finding.reason}（未能定位宿主组合行，请卸载后重装该插件）`,
          })
          continue
        }
        resolvable = true
        resolved.push({
          ...finding, key: stableKey, id: hostIds[0],
          category: classifyDetail(finding.reason, finding.category), source: 'client',
          reason: `客户端插件启动失败（浏览器端）：${finding.reason}`,
        })
        for (const id of hostIds) {
          if (!disabled.has(id)) entryIds.add(id)
        }
      }
      const { acted } = this.apply(resolved, { entryIds: [...entryIds], removeBundles: [], repairPaths: [] })
      return { relevant: true, acted, resolvable }
    } catch (error) {
      this.opts.log(`plugin guard client-console threw: ${String(error)}`)
      return { relevant: false, acted: false, resolvable: false }
    }
  }

  /**
   * ready 态巡检窗口清零（每次 sidecar ready 时调用）。轮转保证 ready 时的当前日志只含
   * 本轮 child 输出，而能走到 ready 的 boot 是干净的——无需跳过 boot 段；两轮确认
   * 窗口同时清零。
   */
  patrolBegin(): void {
    this.patrolActionablePrev.clear()
  }

  /**
   * ready 态日志巡检（每轮 tick 调用，宿主健康、无 crash 事件可挂）。兜住 live-apply
   * 失败：sidecar 不死，失败只留 sidecar.log 一条 HMR warn + 完整错误文本，崩溃诊断通道
   * 结构性看不见。诊断签名与崩溃通道共用；隔离行经宿主 live watch 即时生效，无需
   * restart。可动作项需连续两轮出现在巡检窗口内才落行——安装/更新中途的半写重组是
   * 瞬态（HMR 自带 dirty 重试），一轮确认会把已自愈的状态固化成永久隔离。
   */
  patrol(): void {
    try {
      const text = this.opts.readLog()
      if (text === null || text === '') return
      const window = text.slice(-PluginGuard.PATROL_WINDOW)
      if (!window.includes('failed')) return // 廉价预过滤：无失败字样的窗口直接跳过
      const table = readLayerTable({ dshHome: this.opts.dshHome, profile: this.opts.profile })
      const findings = diagnoseLog(window, table)
      if (findings.length === 0) {
        this.patrolActionablePrev.clear()
        return
      }
      const disabled = disabledEntryIds({ dshHome: this.opts.dshHome })
      const entryIds = new Set<string>()
      const actionableKeys = new Set<string>()
      for (const finding of findings) {
        if (finding.kind !== 'entry') continue
        const hostIds = resolveHostRowIds(table, finding)
        if (hostIds === undefined) continue
        const key = `entry:${hostIds[0]}`
        actionableKeys.add(key)
        if (!this.patrolActionablePrev.has(key)) continue // 首轮只记账，次轮仍在才动作
        for (const id of hostIds) {
          if (!disabled.has(id)) entryIds.add(id)
        }
      }
      this.patrolActionablePrev = actionableKeys
      this.apply(findings.map(f => ({ ...f, source: 'runtime' as const })), {
        entryIds: [...entryIds],
        removeBundles: [],
        repairPaths: [],
      })
    } catch (error) {
      this.opts.log(`plugin guard patrol threw: ${String(error)}`)
    }
  }

  /** 待报告条目（ready 后弹窗用）。 */
  onReady(): GuardFinding[] {
    try {
      return this.ledger.load().unreported
    } catch {
      return []
    }
  }

  /** 全部历史条目（托盘「插件隔离报告」重开用）。 */
  findings(): GuardFinding[] {
    try {
      return this.ledger.load().findings
    } catch {
      return []
    }
  }

  markReported(): void {
    try {
      this.ledger.markReported()
    } catch (error) {
      this.opts.log(`plugin guard markReported threw: ${String(error)}`)
    }
  }

  /** 重新启用：移除全部隔离行并清空台账（bundle 移除不自动恢复——那是损坏件，重装才有意义）。 */
  reEnableAll(): { removed: string[] } {
    try {
      const { removed } = removeQuarantine({ dshHome: this.opts.dshHome })
      this.ledger.clear()
      this.quarantined = 0
      this.emptyDiagnosisStreak = 0
      this.safeModeTried = false
      return { removed }
    } catch (error) {
      this.opts.log(`plugin guard re-enable threw: ${String(error)}`)
      return { removed: [] }
    }
  }

  /**
   * 统一落盘：修复损坏层 → 移出 bundle → 写隔离行（受上限约束）→ 台账 → 日志 → 通知。
   * suppressedByBudget = 有可动作 entryIds 因预算截断而未写行（considerCrash 的连击依据）。
   */
  private apply(findings: readonly GuardFinding[], actions: { entryIds: readonly string[]; removeBundles: readonly string[]; repairPaths: readonly string[] }): { acted: boolean; suppressedByBudget: boolean } {
    let acted = false
    if (actions.repairPaths.length > 0) {
      try {
        const { reset } = repairCorruptLayers({ dshHome: this.opts.dshHome, paths: actions.repairPaths })
        if (reset.length > 0) acted = true
      } catch (error) {
        this.opts.log(`plugin guard layer-repair threw: ${String(error)}`)
      }
    }
    if (actions.removeBundles.length > 0) {
      try {
        const { written } = quarantineBundles({ dshHome: this.opts.dshHome, names: actions.removeBundles })
        if (written.length > 0) {
          acted = true
          this.quarantined += written.length
          this.opts.log(`plugin guard: 已将问题插件包移出启动清单：${written.join('、')}`)
        }
      } catch (error) {
        this.opts.log(`plugin guard bundle-quarantine threw: ${String(error)}`)
      }
    }
    const budget = (this.opts.maxQuarantined ?? 8) - this.quarantined
    const capped = budget > 0 ? actions.entryIds.slice(0, budget) : []
    const suppressedByBudget = actions.entryIds.length > capped.length
    if (capped.length > 0) {
      try {
        const { written } = quarantineEntries({ dshHome: this.opts.dshHome, ids: capped })
        if (written.length > 0) {
          acted = true
          this.quarantined += written.length
          this.opts.log(`plugin guard: 已停用问题插件：${written.join('、')}`)
        }
      } catch (error) {
        this.opts.log(`plugin guard entry-quarantine threw: ${String(error)}`)
      }
    }
    for (const finding of findings) {
      const label = finding.id ?? finding.name ?? finding.bundle ?? finding.path ?? finding.key
      this.opts.log(`plugin guard: [${finding.category}] ${label} — ${finding.reason}`)
    }
    try {
      const added = this.ledger.record(findings)
      if (added.length > 0) {
        this.opts.log(`plugin guard: 新增 ${added.length} 条问题记录`)
        try {
          this.opts.onNewFindings?.(added)
        } catch {
          /* 通知通道自身故障不得影响守卫主流程 */
        }
      }
    } catch (error) {
      this.opts.log(`plugin guard ledger threw: ${String(error)}`)
    }
    return { acted, suppressedByBudget }
  }
}
