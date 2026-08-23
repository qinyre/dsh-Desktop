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
  /** tracked 中包清单声明了 JS 入口但入口文件缺失者（半安装残骸：重装同 spec 不恢复，预隔离）。 */
  brokenBundles: string[]
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
  const table: LayerTable = { rows: [], idsByName: new Map(), bundles: [], tracked: [], corruptLayers: [], missingBundles: [], brokenBundles: [] }
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
    if (tracked && declaredEntryMissing(dirname(pkgPath))) {
      // 半安装残骸：入口文件缺失的行必炸 import（hoisted linker 下 row.name===包名确定性命中），
      // 且同 spec 重装不恢复（pnpm 视为已装）——由守卫预隔离，修复须先卸载再装。
      table.brokenBundles.push(name)
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

/**
 * 「用户域」行 id：tracked bundle 行 + profile/home 用户层非 bundle 行。守卫的自动停用
 * （安全模式、运行期 failed）与托盘的手动停用共用此口径——系统级 bundle（dsh-base 等模板件）
 * 绝不出现在停用名单里。不含「已停用」过滤，调用方按需叠加。
 */
export function userDomainRowIds(table: LayerTable): string[] {
  const tracked = new Set(table.tracked)
  const ids: string[] = []
  for (const row of table.rows) {
    if (isBundleRow(row.source)) {
      const bundle = bundleNameOfRowSource(row.source)
      if (bundle === undefined || !tracked.has(bundle)) continue
    }
    ids.push(row.id)
  }
  return ids
}

/**
 * 同名不同 id 的重复组合（name 对 loader 合法、group 只查重 id，但双行 = 同模块
 * 双 apply：服务/locale 命名空间级冲突的温床）。排除已失效行（insert 自带 disabled
 * 或被裸行 {id, disabled} 覆盖——后者含守卫自己的历史隔离行，不排除会每轮误报）。
 * 返回仍处于生效态的同名模块名列表。
 */
export function findDuplicateNames(table: LayerTable, disabledIds: ReadonlySet<string>): string[] {
  const seen = new Map<string, number>()
  for (const row of table.rows) {
    if (row.name === '' || row.disabled || disabledIds.has(row.id)) continue
    seen.set(row.name, (seen.get(row.name) ?? 0) + 1)
  }
  return [...seen.entries()].filter(([, n]) => n > 1).map(([name]) => name)
}

interface PackageManifestShape {
  main?: unknown
  module?: unknown
  exports?: unknown
}

/**
 * 按 node 的解析优先级从包清单取 JS 入口：exports['.'] 优先（字符串，或条件对象取
 * import → default → require 分支——真实 dsh 包是 {types, default} 形态），其后 main、
 * module。都不声明（纯 patch 层 bundle 的合法形态）返回 undefined。
 */
function entryFieldOf(pkg: PackageManifestShape): string | undefined {
  const dot = (pkg.exports as Record<string, unknown> | undefined | null)?.['.']
  if (typeof dot === 'string' && dot !== '') return dot
  if (dot !== null && typeof dot === 'object' && !Array.isArray(dot)) {
    for (const key of ['import', 'default', 'require']) {
      const value = (dot as Record<string, unknown>)[key]
      if (typeof value === 'string' && value !== '') return value
    }
  }
  if (typeof pkg.main === 'string' && pkg.main !== '') return pkg.main
  if (typeof pkg.module === 'string' && pkg.module !== '') return pkg.module
  return undefined
}

/**
 * 包清单声明了 JS 入口但入口文件在磁盘上缺失（半安装残骸的典型形态：EPERM 中断掏空
 * 了 dist 而 package.json 幸存）。未声明入口或清单不可读返回 false——那些形态归
 * missingBundles/corruptLayers 等其他判据管。
 */
export function declaredEntryMissing(pkgDir: string): boolean {
  let pkg: PackageManifestShape
  try {
    pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as PackageManifestShape
  } catch {
    return false
  }
  const entry = entryFieldOf(pkg)
  return entry !== undefined && !existsSync(join(pkgDir, entry))
}

/** 行来源是否为插件包内的 patch 层（node_modules 下）。 */
export function isBundleRow(source: string): boolean {
  return source.includes(`${sep}node_modules${sep}`)
}

/**
 * 从 bundle patch 层路径提取 bundle 包名（node_modules 后第一段；scoped 包取两段）。
 * scoped 段用 npm 规范的 '/' 连接——包名永远是 POSIX 斜杠形态，与 manifest/lockfile
 * 一致；用 path.sep 连接在 Windows 上会得到 '@scope\pkg'，与 tracked 名永不相等
 * （scoped 包的隔离路径会被整体判成系统行）。
 */
export function bundleNameOfRowSource(source: string): string | undefined {
  const marker = `${sep}node_modules${sep}`
  const at = source.lastIndexOf(marker)
  if (at === -1) return undefined
  const segments = source.slice(at + marker.length).split(sep)
  const first = segments[0] ?? ''
  const name = first.startsWith('@') && segments.length > 1 ? `${first}/${segments[1]}` : first
  return name === '' || name === `@` ? undefined : name
}
