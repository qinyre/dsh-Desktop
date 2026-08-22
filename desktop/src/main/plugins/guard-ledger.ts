import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { GuardFinding } from './guard-diagnose'

export interface GuardLedgerFile {
  version: 1
  /** 全部诊断结论（按 key 去重合并），供托盘「插件隔离报告」随时重开。 */
  findings: GuardFinding[]
  /** 尚未弹窗报告过的新增条目（ready 后弹一次即清）。 */
  unreported: GuardFinding[]
}

const EMPTY: GuardLedgerFile = { version: 1, findings: [], unreported: [] }

/**
 * 台账（$DSH_HOME/plugin-guard.json）。读侧永不 throw：损坏/缺失返回空台账——
 * 台账只是报告通道，不承担正确性，坏了就当没有历史。
 * 写侧（record/markReported/clear 内部 save）失败会 throw，由 PluginGuard 统一留痕。
 */
export class GuardLedgerStore {
  constructor(private readonly filePath: string) {}

  load(): GuardLedgerFile {
    if (!existsSync(this.filePath)) return { ...EMPTY, findings: [], unreported: [] }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as Partial<GuardLedgerFile>
      const findings = Array.isArray(parsed.findings) ? parsed.findings : []
      const unreported = Array.isArray(parsed.unreported) ? parsed.unreported : []
      return { version: 1, findings, unreported }
    } catch {
      return { ...EMPTY, findings: [], unreported: [] }
    }
  }

  save(ledger: GuardLedgerFile): void {
    writeFileSync(this.filePath, JSON.stringify(ledger, null, 2), 'utf8')
  }

  /**
   * 按 key 合并：已存在的条目原地更新 category/reason/source（保留 firstSeen，不重复进
   * unreported——用户报告过一次的问题不再打扰）；新条目进 findings + unreported。
   * 返回新增条目。
   */
  record(findings: readonly GuardFinding[]): GuardFinding[] {
    const ledger = this.load()
    const byKey = new Map(ledger.findings.map(f => [f.key, f]))
    const added: GuardFinding[] = []
    for (const finding of findings) {
      const existing = byKey.get(finding.key)
      if (existing === undefined) {
        byKey.set(finding.key, finding)
        ledger.findings.push(finding)
        added.push(finding)
      } else {
        existing.category = finding.category
        existing.reason = finding.reason
        existing.source = finding.source
      }
    }
    if (added.length > 0) ledger.unreported.push(...added)
    this.save(ledger)
    return added
  }

  markReported(): void {
    const ledger = this.load()
    if (ledger.unreported.length === 0) return
    ledger.unreported = []
    this.save(ledger)
  }

  clear(): void {
    this.save({ ...EMPTY, findings: [], unreported: [] })
  }
}
