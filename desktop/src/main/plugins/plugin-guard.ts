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
      this.apply(findings, { entryIds: [], removeBundles, repairPaths })
    } catch (error) {
      this.opts.log(`plugin guard pre-boot threw: ${String(error)}`)
    }
  }

  /**
   * 崩溃诊断（crashed/failed 时调用，与既有自愈器并列）。读日志 → 签名诊断 → 隔离。
   * 返回是否执行了新的隔离动作；true 且当前 failed 时调用方应显式 restart（预算随之清零）。
   */
  considerCrash(_opts: { terminal: boolean }): { quarantinedNew: boolean } {
    try {
      const text = this.opts.readLog()
      if (text === null || text === '') return { quarantinedNew: false }
      const table = readLayerTable({ dshHome: this.opts.dshHome, profile: this.opts.profile })
      const findings = diagnoseLog(text, table)
      if (findings.length === 0) return { quarantinedNew: false }
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
      const quarantinedNew = this.apply(reportFindings, {
        entryIds: [...entryIds],
        removeBundles: [...removeBundles],
        repairPaths: [...repairPaths],
      })
      return { quarantinedNew }
    } catch (error) {
      this.opts.log(`plugin guard crash-diagnosis threw: ${String(error)}`)
      return { quarantinedNew: false }
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
