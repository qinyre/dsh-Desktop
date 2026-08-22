import { dialog, type BrowserWindow } from 'electron'
import type { GuardCategory, GuardFinding } from './guard-diagnose'

export const CATEGORY_LABELS: Record<GuardCategory, string> = {
  conflict: '冲突',
  'dependency-missing': '依赖缺失',
  'plugin-error': '运行故障',
  'config-corrupt': '配置损坏',
}

export function findingLabel(f: GuardFinding): string {
  return f.name ?? f.id ?? f.bundle ?? f.path ?? f.key
}

/** 弹窗文案（纯函数，可单测）。空列表返回 null（不弹）。 */
export function buildGuardReport(findings: readonly GuardFinding[]): { title: string; message: string; detail: string; buttons: string[] } | null {
  if (findings.length === 0) return null
  const title = '已自动隔离问题插件'
  const message = `为保证客户端正常启动，已自动屏蔽 ${findings.length} 个问题插件。其余功能不受影响；修复或移除问题插件后可重新启用。`
  const detail = findings.map(f => `• ${findingLabel(f)}（${CATEGORY_LABELS[f.category]}）：${f.reason}`).join('\n')
  const buttons = ['知道了', '打开日志目录', '重新启用已隔离插件']
  return { title, message, detail, buttons }
}

/**
 * 原生弹窗报告（electron 耦合只留在这一个函数）。已隔离插件的重新启用经壳层 restart
 * 走监督链；「打开日志目录」与失败页同款。win 缺失时仍弹（无父窗）。
 */
export async function showGuardReport(opts: {
  win: BrowserWindow | undefined
  findings: readonly GuardFinding[]
  onOpenLogs: () => void
  onReenable: () => void
}): Promise<void> {
  const report = buildGuardReport(opts.findings)
  if (report === null) return
  const openLogsIndex = 1
  const reenableIndex = 2
  const result = await (opts.win === undefined
    ? dialog.showMessageBox({ type: 'warning', ...report, defaultId: 0, cancelId: 0, noLink: true })
    : dialog.showMessageBox(opts.win, { type: 'warning', ...report, defaultId: 0, cancelId: 0, noLink: true }))
  if (result.response === openLogsIndex) opts.onOpenLogs()
  else if (result.response === reenableIndex) opts.onReenable()
}
