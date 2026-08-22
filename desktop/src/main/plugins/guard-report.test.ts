import { describe, expect, it } from 'vitest'
import type { GuardFinding } from './guard-diagnose'
import { buildGuardReport, CATEGORY_LABELS, findingLabel } from './guard-report'

const finding = (over: Partial<GuardFinding>): GuardFinding => ({
  key: 'entry:x', kind: 'entry', category: 'plugin-error', reason: 'boom', source: 'crash',
  firstSeen: '2026-08-22T00:00:00.000Z', ...over,
})

describe('buildGuardReport', () => {
  it('returns null for an empty list', () => {
    expect(buildGuardReport([])).toBeNull()
  })

  it('builds title/message/detail/buttons for mixed findings', () => {
    const report = buildGuardReport([
      finding({ key: 'entry:mock-crash', id: 'mock-crash', name: 'mock-crash', category: 'plugin-error', reason: 'Error: boom' }),
      finding({ key: 'entry:mock-import', id: 'mock-import', name: 'mock-import', category: 'dependency-missing', reason: "Cannot find package './missing.js'" }),
      finding({ key: 'entry:dup', id: 'dup', name: 'dup', category: 'conflict', reason: 'entry id 重复' }),
    ])
    expect(report!.title).toContain('隔离')
    expect(report!.message).toContain('3')
    expect(report!.detail).toContain('mock-crash（运行故障）')
    expect(report!.detail).toContain('mock-import（依赖缺失）')
    expect(report!.detail).toContain('dup（冲突）')
    expect(report!.buttons).toEqual(['知道了', '打开日志目录', '重新启用已隔离插件'])
  })

  it('labels every category in Chinese and falls back through id/bundle/path', () => {
    expect(CATEGORY_LABELS['config-corrupt']).toBe('配置损坏')
    expect(CATEGORY_LABELS['safe-mode']).toBe('安全模式')
    expect(findingLabel(finding({ name: undefined, id: 'e1' }))).toBe('e1')
    expect(findingLabel(finding({ kind: 'bundle', bundle: 'b1', id: undefined }))).toBe('b1')
  })
})
