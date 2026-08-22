import { basename, join, sep } from 'node:path'
import { bundleNameOfRowSource, findDuplicateEntryIds, isBundleRow, readLayerTable, type LayerTable } from './patch-layers'
import { diagnoseLog, type GuardFinding } from './guard-diagnose'
import { disabledEntryIds, quarantineBundles, quarantineEntries, repairCorruptLayers, removeQuarantine } from './guard-quarantine'
import { GuardLedgerStore } from './guard-ledger'

export interface PluginGuardOpts {
  dshHome: string
  /** 读 sidecar 当前日志全文（崩溃诊断的输入）；不可用时返回 null。 */
  readLog: () => string | null
  log: (line: string) => void
  profile?: string
  /** 单进程累计隔离动作（行 + bundle）上限，防无限循环。默认 8。 */
  maxQuarantined?: number
}

const nowIso = (): string => new Date().toISOString()

/** 无可定位诊断的失败连续达到此次数 → 进入安全模式（一次性全量停用 tracked 插件）。 */
const SAFE_MODE_AFTER = 2

/** 环境级 spawn 故障（可执行文件缺失/被锁等）不是插件问题：不计连击（也不清零，保持现状）。 */
const SPAWN_ERROR_RE = /Error: spawn\b|spawn ENOENT|EACCES/

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
      this.apply(findings, { entryIds: [...brokenRowIds], removeBundles, repairPaths })
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
      let acted = false
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
        acted = this.apply(reportFindings, {
          entryIds: [...entryIds],
          removeBundles: [...removeBundles],
          repairPaths: [...repairPaths],
        })
      }
      if (acted) {
        this.emptyDiagnosisStreak = 0
        return { quarantinedNew: true }
      }
      // 连击计数：本轮既无可动作发现（entry/bundle 类）、又无新隔离动作、也非环境级
      // spawn 故障，才视为一次「无证据失败」。boot:include（kind=service）之类的报告
      // 轮不计——AggregateError 多失败恰好只产出它，必须让连击走下去才能进安全模式。
      // 触发检查收在增量分支内：安全模式后的「有发现但无动作」轮不误报环境问题。
      const actionable = findings.some(f => f.kind === 'entry' || f.kind === 'bundle')
      if (!actionable && !SPAWN_ERROR_RE.test(text.slice(-500))) {
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
    const tracked = new Set(table.tracked)
    const ids = new Set<string>()
    for (const row of table.rows) {
      if (disabled.has(row.id)) continue
      if (isBundleRow(row.source)) {
        const bundle = bundleNameOfRowSource(row.source)
        if (bundle === undefined || !tracked.has(bundle)) continue
      }
      ids.add(row.id)
    }
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

  /** boot 成功（ready）：无证据连击清零——成功本身证明配置可行。 */
  noteBootSuccess(): void {
    this.emptyDiagnosisStreak = 0
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
      if (failed.length === 0 && pending.length === 0) return
      const table = readLayerTable({ dshHome: this.opts.dshHome, profile: this.opts.profile })
      const tracked = new Set(table.tracked)
      const userDomain = new Set<string>()
      for (const row of table.rows) {
        if (isBundleRow(row.source)) {
          const bundle = bundleNameOfRowSource(row.source)
          if (bundle === undefined || !tracked.has(bundle)) continue
        }
        userDomain.add(row.id)
      }
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
      this.apply(findings, { entryIds: quarantineIds, removeBundles: [], repairPaths: [] })
    } catch (error) {
      this.opts.log(`plugin guard runtime threw: ${String(error)}`)
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

  /** 统一落盘：修复损坏层 → 移出 bundle → 写隔离行（受上限约束）→ 台账 → 日志。 */
  private apply(findings: readonly GuardFinding[], actions: { entryIds: readonly string[]; removeBundles: readonly string[]; repairPaths: readonly string[] }): boolean {
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
      if (added.length > 0) this.opts.log(`plugin guard: 新增 ${added.length} 条问题记录`)
    } catch (error) {
      this.opts.log(`plugin guard ledger threw: ${String(error)}`)
    }
    return acted
  }
}
