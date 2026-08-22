import type { LayerTable } from './patch-layers'

/** 问题类别（对用户口径：冲突 / 依赖缺失 / 运行故障 / 配置损坏 / 安全模式）。 */
export type GuardCategory = 'conflict' | 'dependency-missing' | 'plugin-error' | 'config-corrupt' | 'safe-mode'

export type GuardFindingKind = 'entry' | 'bundle' | 'file' | 'service'

/** 一条诊断结论。kind=entry 且 id 非空 → 可写隔离行；其余仅报告。 */
export interface GuardFinding {
  key: string
  kind: GuardFindingKind
  id?: string
  name?: string
  bundle?: string
  path?: string
  category: GuardCategory
  reason: string
  source: 'pre-boot' | 'crash' | 'runtime'
  firstSeen: string
}

// 签名格式逐字取自 harness 源码（详见实施计划「关键事实」1-7）：
const RE_ENTRY_FAIL = /failed to (?:import|apply) loader entry (\S+) \(([^)]*)\): (.*)/
const RE_MISSING_MODULE = /Cannot find (?:package|module)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/
const RE_LOAD_FAIL = /plugin\(s\) failed to load: ([^;]+);/
const RE_DUP = /duplicate loader entry id: (\S+)/
const RE_SVC = /service "([^"]+)" has been registered at <([^>]+)>/
const RE_SKIP_BUNDLE = /warning: skipping profile bundle "([^"]+)"/
const RE_RESOLVE_BUNDLE = /cannot resolve profile bundle "([^"]+)"/
// 路径可含空格（打包模式 DSH_HOME 在 userData 下），用 .+? 非贪婪停在 ": " 前。
const RE_PARSE_FAIL = /failed to parse (?:patches|overlay) (.+?): /
const RE_DID_NOT_ACTIVATE = /: \d+ (?:entry|entries) did not activate/
const RE_PENDING = /^(\S+): pending \(waiting for (?:service|services): ([^)]+)\)/
const RE_NAME_LINE = /^([\w@][\w@/.-]*): (.+)$/

const REASON_LIMIT = 300
function cut(text: string): string {
  return text.replaceAll('\n', ' ').slice(0, REASON_LIMIT)
}

const nowIso = (): string => new Date().toISOString()

/**
 * 解析 sidecar 日志中的插件故障签名 → 结构化诊断。按 key 去重（先见者胜）。
 * table 提供模块名 → entry id 映射（激活审计块只带模块名）；缺省时按名字本身当 id 用。
 */
export function diagnoseLog(logText: string, table: LayerTable | undefined): GuardFinding[] {
  const found = new Map<string, GuardFinding>()
  const add = (finding: Omit<GuardFinding, 'firstSeen'>): void => {
    if (!found.has(finding.key)) {
      found.set(finding.key, { ...finding, reason: cut(finding.reason), firstSeen: nowIso() })
    }
  }
  const nameToIds = (name: string): string[] => table?.idsByName.get(name) ?? [name]
  const lines = logText.split(/\r?\n/)
  let inActivateBlock = false
  for (const line of lines) {
    let m: RegExpMatchArray | null
    if ((m = line.match(RE_ENTRY_FAIL)) !== null) {
      const id = m[1]!
      const name = m[2] ?? ''
      const detail = m[3] ?? ''
      if (id === 'include') {
        // 根 include entry 会把 group.update 的组合期错误（典型：duplicate loader entry id）
        // 包装成自己的 apply 失败——它不是可隔离的插件（冒烟实测）。从 detail 里提取真实
        // 签名；提取不出则按基础设施失败仅报告。
        const dup = detail.match(RE_DUP)
        if (dup !== null) {
          const dupId = dup[1]!
          add({ key: `entry:${dupId}`, kind: 'entry', id: dupId, category: 'conflict', reason: `entry id 重复：${dupId}`, source: 'crash' })
        } else {
          add({ key: 'boot:include', kind: 'service', category: RE_MISSING_MODULE.test(detail) ? 'dependency-missing' : 'plugin-error', reason: `启动组合失败：${detail}`, source: 'crash' })
        }
      } else {
        add({
          key: `entry:${id}`, kind: 'entry', id, name: name === '' ? undefined : name,
          category: RE_MISSING_MODULE.test(detail) ? 'dependency-missing' : 'plugin-error',
          reason: detail, source: 'crash',
        })
      }
    } else if ((m = line.match(RE_LOAD_FAIL)) !== null) {
      for (const name of (m[1] ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
        for (const id of nameToIds(name)) {
          add({ key: `entry:${id}`, kind: 'entry', id, name, category: 'dependency-missing', reason: `模块未能解析：${name}`, source: 'crash' })
        }
      }
    } else if ((m = line.match(RE_DUP)) !== null) {
      const id = m[1]!
      add({ key: `entry:${id}`, kind: 'entry', id, category: 'conflict', reason: `entry id 重复：${id}`, source: 'crash' })
    } else if ((m = line.match(RE_SVC)) !== null) {
      const svc = m[1]!
      const fiber = m[2] ?? ''
      // fiber 名里若能找到已知 entry id 则可隔离；否则仅报告（fiber→entry 映射不可靠）。
      const hit = table?.rows.find(row => fiber.includes(row.id) && row.id.length > 2)
      add({
        key: `service:${svc}`, kind: hit === undefined ? 'service' : 'entry',
        id: hit?.id, name: hit?.name, category: 'conflict',
        reason: `服务重复注册：${svc}（${fiber}）`, source: 'crash',
      })
    } else if ((m = line.match(RE_SKIP_BUNDLE)) !== null || (m = line.match(RE_RESOLVE_BUNDLE)) !== null) {
      const name = m[1]!
      add({ key: `bundle:${name}`, kind: 'bundle', bundle: name, category: 'dependency-missing', reason: `bundle 缺件或被本次启动跳过：${name}`, source: 'crash' })
    } else if ((m = line.match(RE_PARSE_FAIL)) !== null) {
      const path = m[1]!
      add({ key: `file:${path}`, kind: 'file', path, category: 'config-corrupt', reason: `补丁层无法解析：${path}`, source: 'crash' })
    } else if (RE_DID_NOT_ACTIVATE.test(line)) {
      inActivateBlock = true
      continue
    } else if (inActivateBlock) {
      if ((m = line.match(RE_PENDING)) !== null) {
        const name = m[1]!
        const missing = m[2] ?? ''
        for (const id of nameToIds(name)) {
          add({ key: `entry:${id}`, kind: 'entry', id, name, category: 'dependency-missing', reason: `等待的服务未提供：${missing}`, source: 'crash' })
        }
      } else if ((m = line.match(RE_NAME_LINE)) !== null) {
        const name = m[1]!
        const detail = m[2] ?? ''
        for (const id of nameToIds(name)) {
          add({
            key: `entry:${id}`, kind: 'entry', id, name,
            category: RE_MISSING_MODULE.test(detail) ? 'dependency-missing' : 'plugin-error',
            reason: detail, source: 'crash',
          })
        }
      } else if (line.trim() !== '' && !line.startsWith(' ')) {
        // 非缩进、非「名字:」形态的行 = activate 块结束（后续是外层错误链输出）。
        inActivateBlock = false
      }
    }
  }
  return [...found.values()]
}
