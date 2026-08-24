import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument, YAMLMap, YAMLSeq } from 'yaml'
import { patchYamlOptions } from './patch-layers'
import type { MenuItemConstructorOptions } from 'electron'
import { bundleNameOfRowSource, isBundleRow, readLayerTable, userDomainRowIds, type LayerTable } from './patch-layers'
import { disabledEntryIds, disableEntries, enableAllEntries, enableEntries, QUARANTINE_MARKER, restoreBundles } from './guard-quarantine'

/**
 * 托盘级插件管理（设计书 docs/superpowers/specs/2026-08-24-tray-plugin-manager-design.md）。
 * 页面打不开（插件冲突/崩溃）时应用内插件管理器不可用——本模块在主进程直读直写磁盘，
 * 不依赖 sidecar 存活与任何渲染页。本类不 import electron（菜单模板构建只用类型导入），
 * 与 PluginGuard 同规：所有动作可抛错，由 electron 耦合层（tray-plugin-section）捕获转对话框。
 */
export const TRAY_DISABLE_MARKER = 'dsh-desktop tray-plugin-manager disable'

/** 停用归因：守卫自动隔离 / 托盘手动停用 / 页面内插件管理器（或手写 YAML）停用。 */
export type DisableSource = 'guard' | 'manual' | 'webui'

export interface TrayPluginInfo {
  /** 包名（唯一标识；scoped 用 POSIX 斜杠形态，与 manifest/lockfile 一致）。 */
  bundle: string
  version?: string
  /** 该包全部 insert 行的宿主 entry id（客户端树按 name 反查同一批行）。 */
  entryIds: string[]
  state: 'enabled' | 'disabled' | 'mixed'
  /** disabled/mixed 时的停用归因（优先级 guard > manual > webui）。 */
  reason?: DisableSource
  /** 仅剩 insert 自带 disabled（包内声明停用）：裸行无法启用，托盘不可勾选。 */
  nativeDisabledOnly: boolean
  /** 缺件/半安装残骸（missingBundles/brokenBundles）：守卫口径，只展示。 */
  broken: boolean
}

export interface QuarantinedBundle {
  name: string
}

export interface ManagedInventory {
  plugins: TrayPluginInfo[]
  quarantined: QuarantinedBundle[]
  corruptHint?: string
}

interface ProfileManifest {
  bundles: string[]
  dependencies: string[]
}

function readProfileManifest(dshHome: string): ProfileManifest | undefined {
  const manifestPath = join(dshHome, 'profiles', 'web', 'package.json')
  if (!existsSync(manifestPath)) return undefined
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      dependencies?: Record<string, unknown>
      dsh?: { profile?: { bundles?: unknown } }
    }
    const bundles = Array.isArray(parsed.dsh?.profile?.bundles) ? parsed.dsh.profile.bundles.filter((x): x is string => typeof x === 'string') : []
    return { bundles, dependencies: Object.keys(parsed.dependencies ?? {}) }
  } catch {
    return undefined
  }
}

function readBundleVersion(dshHome: string, name: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(dshHome, 'profiles', 'web', 'node_modules', name, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : undefined
  } catch {
    return undefined
  }
}

/** 包在磁盘上仍是插件形态（声明 dsh.bundle.patch，或依赖默认路径 cordis.patch.yml 存在）。 */
function looksLikePluginPackage(dshHome: string, name: string): boolean {
  const pkgDir = join(dshHome, 'profiles', 'web', 'node_modules', name)
  try {
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { dsh?: { bundle?: { patch?: unknown } } }
    if (typeof pkg.dsh?.bundle?.patch === 'string') return true
  } catch {
    return false
  }
  return existsSync(join(pkgDir, 'cordis.patch.yml'))
}

const REASON_PRIORITY: DisableSource[] = ['guard', 'manual', 'webui']

/**
 * 扫 home+profile 两层的停用裸行并归因（commentBefore 标记）。键集合限制与
 * guard-quarantine.isBareDisableRow 同口径：带 config 等多余键的行不是插件停用行。
 * 同一 id 多来源并存时按 guard > manual > webui 归并（守卫行在 home、页面内行在
 * profile，两层都扫完再取高优先级，不能让后扫的层覆盖先扫的层）。
 * 解析失败的层跳过（层表 corruptHint 会另行提示）。
 */
function scanDisableAttributions(dshHome: string): Map<string, DisableSource> {
  const found = new Map<string, DisableSource>()
  for (const path of [join(dshHome, 'cordis.patch.yml'), join(dshHome, 'profiles', 'web', 'cordis.patch.yml')]) {
    if (!existsSync(path)) continue
    let seq: YAMLSeq | undefined
    try {
      const doc = parseDocument(readFileSync(path, 'utf8'), patchYamlOptions) // 宿主 !!js 方言：注册后不告警不依赖降级
      if (doc.errors.length > 0 || (doc.contents !== null && !(doc.contents instanceof YAMLSeq))) continue
      seq = doc.contents instanceof YAMLSeq ? doc.contents : undefined
    } catch {
      continue
    }
    if (seq === undefined) continue
    for (const item of seq.items) {
      if (!(item instanceof YAMLMap) || item.get('disabled') !== true) continue
      const id = item.get('id')
      if (typeof id !== 'string' || id === '') continue
      let bare = true
      for (const pair of item.items) {
        const key = String(pair.key)
        if (key !== 'id' && key !== 'name' && key !== 'disabled') { bare = false; break }
      }
      if (!bare) continue
      const comment = item.commentBefore ?? ''
      const source: DisableSource = comment.includes(QUARANTINE_MARKER)
        ? 'guard'
        : comment.includes(TRAY_DISABLE_MARKER) ? 'manual' : 'webui'
      const existing = found.get(id)
      if (existing === undefined || REASON_PRIORITY.indexOf(source) < REASON_PRIORITY.indexOf(existing)) {
        found.set(id, source)
      }
    }
  }
  return found
}

function reasonOf(ids: readonly string[], attributions: ReadonlyMap<string, DisableSource>): DisableSource | undefined {
  for (const candidate of REASON_PRIORITY) {
    if (ids.some(id => attributions.get(id) === candidate)) return candidate
  }
  return undefined
}

function pluginInfoOf(table: LayerTable, name: string, disabledIds: ReadonlySet<string>, attributions: ReadonlyMap<string, DisableSource>): TrayPluginInfo {
  const rows = table.rows.filter(row => isBundleRow(row.source) && bundleNameOfRowSource(row.source) === name)
  const entryIds = rows.map(row => row.id)
  const disabledRows = rows.filter(row => row.disabled || disabledIds.has(row.id))
  const externallyDisabled = entryIds.filter(id => attributions.has(id))
  return {
    bundle: name,
    version: undefined,
    entryIds,
    state: disabledRows.length === 0 ? 'enabled' : disabledRows.length === rows.length ? 'disabled' : 'mixed',
    reason: reasonOf(entryIds, attributions),
    // 有停用行但没有任何可删的停用裸行 = 只剩 insert 自带 disabled（或 disabledIds 命中
    // 了无法归因的行——同样没有可删目标），启用是空操作，不可勾选。
    nativeDisabledOnly: disabledRows.length > 0 && externallyDisabled.length === 0,
    broken: table.missingBundles.includes(name) || table.brokenBundles.includes(name),
  }
}

/**
 * 托盘插件清单。tracked bundle（用户安装级插件）逐个列状态；dependencies ∖ bundles 中
 * 仍是插件形态者为「已移出清单」组（守卫 bundle 级隔离件——过滤掉升级后不再声明 bundle 的
 * 普通依赖库，reconciler 会把这类留在 dependencies 里）。永不 throw：层坏时 corruptHint 提示。
 */
export function listManagedPlugins(opts: { dshHome: string; profile?: string }): ManagedInventory {
  const table = readLayerTable({ dshHome: opts.dshHome, profile: opts.profile })
  const disabledIds = disabledEntryIds({ dshHome: opts.dshHome })
  const attributions = scanDisableAttributions(opts.dshHome)
  const manifest = readProfileManifest(opts.dshHome)
  const plugins = table.tracked.map(name => {
    const info = pluginInfoOf(table, name, disabledIds, attributions)
    if (info.version === undefined) info.version = readBundleVersion(opts.dshHome, name)
    return info
  })
  const inBundles = new Set(manifest?.bundles ?? table.bundles)
  const quarantined = (manifest?.dependencies ?? [])
    .filter(name => !inBundles.has(name) && looksLikePluginPackage(opts.dshHome, name))
    .map(name => ({ name }))
  return {
    plugins,
    quarantined,
    corruptHint: table.corruptLayers.length > 0 ? '部分配置层无法读取，状态可能不全，详见日志目录' : undefined,
  }
}

/** 单插件启停（幂等 set-to-state）。bundle 不在 tracked / 无可操作行时 throw（调用方转提示）。 */
export function setPluginEnabled(opts: { dshHome: string; bundle: string; enabled: boolean }): { changed: string[] } {
  const table = readLayerTable({ dshHome: opts.dshHome })
  if (!table.tracked.includes(opts.bundle)) throw new Error(`未找到已安装插件：${opts.bundle}`)
  const rows = table.rows.filter(row => isBundleRow(row.source) && bundleNameOfRowSource(row.source) === opts.bundle)
  const ids = rows.map(row => row.id)
  if (ids.length === 0) throw new Error(`插件 ${opts.bundle} 没有可停用/启用的挂载行`)
  if (opts.enabled) return { changed: enableEntries({ dshHome: opts.dshHome, ids }).removed }
  return { changed: disableEntries({ dshHome: opts.dshHome, ids, marker: TRAY_DISABLE_MARKER }).written }
}

/** 手动安全模式：停用全部用户域行（tracked bundle 行 + 用户层非 bundle 行），不动系统件。 */
export function disableAllPlugins(opts: { dshHome: string; profile?: string }): { written: string[] } {
  const table = readLayerTable({ dshHome: opts.dshHome, profile: opts.profile })
  const disabled = disabledEntryIds({ dshHome: opts.dshHome })
  const ids = userDomainRowIds(table).filter(id => !disabled.has(id))
  return disableEntries({ dshHome: opts.dshHome, ids, marker: TRAY_DISABLE_MARKER })
}

/** 全部启用：清两层全部停用裸行。注意：接线层须先 guard.reEnableAll()（重置安全模式闩锁与台账）。 */
export function enableAllPlugins(opts: { dshHome: string }): { removed: string[] } {
  return enableAllEntries({ dshHome: opts.dshHome })
}

/** 恢复 bundle 级隔离件：写回 bundles 列表。manifest 是 boot-only，调用方必须随后重启服务。 */
export function restoreBundle(opts: { dshHome: string; name: string }): { written: string[] } {
  return restoreBundles({ dshHome: opts.dshHome, names: [opts.name] })
}

const REASON_LABELS: Record<DisableSource, string> = {
  guard: '守卫停用',
  manual: '已停用',
  webui: '页面内停用',
}

/** 子菜单里逐插件行数上限（Windows 托盘子菜单不滚动，超出折叠为提示行）。 */
const MENU_PLUGIN_CAP = 20

export interface PluginSectionActions {
  onToggle(bundle: string, enabled: boolean): void
  onDisableAll(): void
  onEnableAll(): void
  onRestore(name: string): void
}

/**
 * 「插件管理」子菜单模板（纯函数；electron 仅类型导入）。语义契约：
 * checkbox 项的 click 读 menuItem.checked（Electron 已翻转为用户目标态），动作幂等
 * set-to-state；mixed 显示未勾选+「部分停用」、点击=启用；包内停用/残缺/无行的项不可勾选。
 */
export function buildPluginSection(inventory: ManagedInventory, actions: PluginSectionActions): MenuItemConstructorOptions {
  const submenu: MenuItemConstructorOptions[] = []
  if (inventory.corruptHint !== undefined) {
    submenu.push({ label: `⚠ ${inventory.corruptHint}`, enabled: false })
  }
  const plugins = inventory.plugins.slice(0, MENU_PLUGIN_CAP)
  if (plugins.length === 0 && inventory.quarantined.length === 0) {
    submenu.push({ label: '暂无已安装插件', enabled: false })
  }
  for (const plugin of plugins) {
    const suffix: string[] = []
    if (plugin.state !== 'enabled' && plugin.reason !== undefined) suffix.push(REASON_LABELS[plugin.reason])
    if (plugin.state === 'mixed') suffix.push('部分停用')
    if (plugin.state !== 'enabled' && plugin.nativeDisabledOnly) suffix.push('包内停用')
    if (plugin.broken) suffix.push('残缺')
    const label = `${plugin.bundle}${plugin.version !== undefined ? ` ${plugin.version}` : ''}${suffix.length > 0 ? `（${suffix.join('·')}）` : ''}`
    const actionable = plugin.entryIds.length > 0 && !plugin.broken && !plugin.nativeDisabledOnly
    submenu.push({
      label,
      type: 'checkbox',
      // mixed 显示未勾选（点击=启用；若保持勾选会误导「已是启用态」）。
      checked: plugin.state === 'enabled',
      enabled: actionable,
      click: (menuItem) => { actions.onToggle(plugin.bundle, menuItem.checked === true) },
    })
  }
  if (inventory.plugins.length > MENU_PLUGIN_CAP) {
    submenu.push({ label: `…其余 ${inventory.plugins.length - MENU_PLUGIN_CAP} 个（请到应用内插件页管理）`, enabled: false })
  }
  if (inventory.quarantined.length > 0) {
    submenu.push({ type: 'separator' })
    for (const item of inventory.quarantined) {
      submenu.push({
        label: `↩ ${item.name}（已移出清单，点击恢复）`,
        click: () => { actions.onRestore(item.name) },
      })
    }
  }
  submenu.push({ type: 'separator' })
  submenu.push({ label: '全部停用…', click: () => { actions.onDisableAll() } })
  submenu.push({ label: '全部启用…', click: () => { actions.onEnableAll() } })
  return { label: '插件管理', submenu }
}
