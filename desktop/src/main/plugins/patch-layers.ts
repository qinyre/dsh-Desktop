import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { parse } from 'yaml'

/** patch 层里的一条 insert 行（entry 声明）。source = 所在 patch 文件的绝对路径。 */
export interface PatchRow {
  id: string
  name: string
  disabled: boolean
  source: string
}

/** 一个无法解析的 patch 层。bundle 有值 = 插件包内层（可移出 bundles 清单）；无值 = 用户层/home 层。 */
export interface CorruptLayer {
  path: string
  bundle?: string
}

export interface LayerTable {
  /** 全部层的 insert 行，按层叠顺序（bundle 层 → profile 用户层 → home 层）。 */
  rows: PatchRow[]
  /** 模块名 → entry id 列表（去重）。 */
  idsByName: Map<string, string[]>
  /** manifest 声明的全部 bundle 名（原序）。 */
  bundles: string[]
  /** 用户安装级 bundle（bundles ∩ dependencies）——仅此集合可被移出清单（见 plugin-guard）。 */
  tracked: string[]
  corruptLayers: CorruptLayer[]
  /** tracked 中 node_modules/<name>/package.json 缺失者（与 profile-heal 审计同口径，仅报告）。 */
  missingBundles: string[]
}

interface PatchItem {
  insert?: Array<{ id?: unknown; name?: unknown; disabled?: unknown } | null>
}

/**
 * 解析一个 patch 层。返回：items = 正常；null = 文件不存在；undefined = 存在但无法解析
 * （YAML 语法错或根不是数组——与 harness parsePatchList 的 fail-loud 判定一致）。
 */
function readPatchLayer(path: string): PatchItem[] | null | undefined {
  if (!existsSync(path)) return null
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const parsed = parse(text) as unknown
    if (!Array.isArray(parsed)) return undefined
    return parsed as PatchItem[]
  } catch {
    return undefined
  }
}

function rowsOfLayer(path: string, items: PatchItem[]): PatchRow[] {
  const rows: PatchRow[] = []
  for (const item of items) {
    for (const entry of item?.insert ?? []) {
      if (entry === null || typeof entry !== 'object') continue
      const id = entry.id === undefined ? undefined : String(entry.id)
      if (id === undefined || id === '') continue
      rows.push({
        id,
        name: entry.name === undefined ? '' : String(entry.name),
        disabled: entry.disabled === true,
        source: path,
      })
    }
  }
  return rows
}

/**
 * 读取 profile 的完整 patch 层栈（bundle 层按 manifest 顺序 + profile 用户层 + home 层），
 * 供静态预检与崩溃诊断做 id/name 映射。永不 throw：任何读取/解析失败都收进
 * corruptLayers / missingBundles，由上层决定修复动作。
 */
export function readLayerTable(opts: { dshHome: string; profile?: string }): LayerTable {
  const profileName = opts.profile ?? 'web'
  const profileDir = join(opts.dshHome, 'profiles', profileName)
  const table: LayerTable = { rows: [], idsByName: new Map(), bundles: [], tracked: [], corruptLayers: [], missingBundles: [] }
  const manifestPath = join(profileDir, 'package.json')
  let bundles: string[] = []
  let dependencies: string[] = []
  if (existsSync(manifestPath)) {
    try {
      const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        dependencies?: Record<string, unknown>
        dsh?: { profile?: { bundles?: unknown } }
      }
      const list = parsed.dsh?.profile?.bundles
      if (Array.isArray(list)) bundles = list.filter((x): x is string => typeof x === 'string')
      dependencies = Object.keys(parsed.dependencies ?? {})
    } catch {
      table.corruptLayers.push({ path: manifestPath })
    }
  }
  table.bundles = bundles
  const depSet = new Set(dependencies)
  table.tracked = bundles.filter(name => depSet.has(name))
  for (const name of bundles) {
    const tracked = depSet.has(name)
    const pkgPath = join(profileDir, 'node_modules', name, 'package.json')
    if (!existsSync(pkgPath)) {
      // 模板 bundle 经安装锚解析时 profile 下可能没有副本，静默跳过；
      // 用户安装级缺件 = 与启动前审计同口径的「bundle 缺件」，仅报告。
      if (tracked) table.missingBundles.push(name)
      continue
    }
    let patchRel = './cordis.patch.yml'
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { dsh?: { bundle?: { patch?: unknown } } }
      if (typeof pkg.dsh?.bundle?.patch === 'string') patchRel = pkg.dsh.bundle.patch
    } catch {
      // 包清单半写 = 安装被打断的残骸，按缺件计（审计会尝试重装）。
      if (tracked) table.missingBundles.push(name)
      continue
    }
    const patchPath = join(dirname(pkgPath), patchRel)
    const items = readPatchLayer(patchPath)
    if (items === undefined || items === null) {
      // 包在而 patch 文件缺失/损坏：tracked 的可移出清单修复；模板的仅报告。
      if (items === undefined || tracked) table.corruptLayers.push({ path: patchPath, bundle: name })
      continue
    }
    table.rows.push(...rowsOfLayer(patchPath, items))
  }
  for (const path of [join(profileDir, 'cordis.patch.yml'), join(opts.dshHome, 'cordis.patch.yml')]) {
    const items = readPatchLayer(path)
    if (items === undefined) {
      table.corruptLayers.push({ path })
      continue
    }
    if (items !== null) table.rows.push(...rowsOfLayer(path, items))
  }
  for (const row of table.rows) {
    if (row.name === '') continue
    const ids = table.idsByName.get(row.name) ?? []
    if (!ids.includes(row.id)) ids.push(row.id)
    table.idsByName.set(row.name, ids)
  }
  return table
}

/** 层栈中重复声明的 entry id（loader 的 group 查重会对这些 id 抛错）。 */
export function findDuplicateEntryIds(table: LayerTable): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const row of table.rows) {
    if (seen.has(row.id)) dup.add(row.id)
    seen.add(row.id)
  }
  return [...dup]
}

/** 行来源是否为插件包内的 patch 层（node_modules 下）。 */
export function isBundleRow(source: string): boolean {
  return source.includes(`${sep}node_modules${sep}`)
}

/** 从 bundle patch 层路径提取 bundle 包名（node_modules 后第一段；scoped 包取两段）。 */
export function bundleNameOfRowSource(source: string): string | undefined {
  const marker = `${sep}node_modules${sep}`
  const at = source.lastIndexOf(marker)
  if (at === -1) return undefined
  const segments = source.slice(at + marker.length).split(sep)
  const first = segments[0] ?? ''
  const name = first.startsWith('@') && segments.length > 1 ? `${first}${sep}${segments[1]}` : first
  return name === '' || name === `@` ? undefined : name
}
