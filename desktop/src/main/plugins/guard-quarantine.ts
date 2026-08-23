import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { parse, parseDocument, YAMLMap, YAMLSeq } from 'yaml'

/**
 * 插件隔离的落盘动作。只写 $DSH_HOME/cordis.patch.yml（home 层，层叠晚于 profile 用户层，
 * 裸行 disabled 可覆盖一切更早层的 insert 行）。绝不把 {id, disabled} 行写进 profile 层——
 * dsh-plugin-install 的 isManagedRow 会把该形状当自己的管理行误删（mounts.ts）。
 * 写侧契约与 market-seed.ts 一致：YAML 文档树重写、整层 block 风格、写前 parse 自检、
 * 就地 writeFileSync（chokidar 按 inode 监听，不得 temp+rename）。
 */
export const QUARANTINE_MARKER = 'dsh-desktop plugin-guard quarantine'

const BACKUP_SUFFIX = '.plugin-guard-bak'

/** 本进程已备份过的目标（首次写入前留预守卫原状；后续写入不再覆盖首份备份）。 */
const backedUp = new Set<string>()

function backupOnce(path: string): void {
  if (backedUp.has(path)) return
  backedUp.add(path)
  if (!existsSync(path)) return // 首写创建的层没有预守卫原状可备
  const bak = path + BACKUP_SUFFIX
  rmSync(bak, { force: true })
  copyFileSync(path, bak)
}

/** 损坏修复专用：每次都覆盖备份（取证语义——捕获本次被重置前的损坏态原文）。 */
function backupAlways(path: string): void {
  const bak = path + BACKUP_SUFFIX
  rmSync(bak, { force: true })
  copyFileSync(path, bak)
}

/** 打开（或初始化）一个用户 patch 层的文档树；无法解析时 throw——绝不落盘可能写坏的层。 */
function patchLayerDoc(path: string): { doc: ReturnType<typeof parseDocument>; seq: YAMLSeq; path: string } {
  const content = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const doc = parseDocument(content)
  if (doc.errors.length > 0) {
    throw new Error(`patch layer does not parse: ${path}: ${doc.errors[0]?.message ?? String(doc.errors[0])}`)
  }
  if (doc.contents !== null && !(doc.contents instanceof YAMLSeq)) {
    throw new Error(`${path}: root is not a list of patch rows`)
  }
  const seq: YAMLSeq = doc.contents instanceof YAMLSeq ? doc.contents : new YAMLSeq() as never
  if (doc.contents === null) doc.contents = seq as never
  return { doc, seq, path }
}

function renderAndWrite(doc: ReturnType<typeof parseDocument>, seq: YAMLSeq, path: string): void {
  setBlockStyle(seq)
  const next = doc.toString({ lineWidth: 0 })
  parse(next) // 写前自检：live watcher 与下次启动都对此文件 fail loud
  // 就地覆盖写与 dsh 侧 MCP/安装器写行存在丢失更新窗口（无锁、chokidar 要求就地写），
  // 备份首份原状供人工恢复——备份≠并发安全，窗口内并发写仍可能互相覆盖。
  backupOnce(path)
  writeFileSync(path, next, 'utf8')
}

function setBlockStyle(node: unknown): void {
  if (node instanceof YAMLMap) {
    node.flow = false
    for (const pair of node.items) setBlockStyle(pair.value)
  } else if (node instanceof YAMLSeq) {
    node.flow = false
    for (const item of node.items) setBlockStyle(item)
  }
}

/** 本层内已处于停用态的 entry id（insert 行自带 disabled 或裸覆盖行 {id, disabled:true}）。 */
function disabledIdsInDoc(seq: YAMLSeq): Set<string> {
  const ids = new Set<string>()
  for (const item of seq.items) {
    if (!(item instanceof YAMLMap)) continue
    if (item.get('disabled') !== true) continue
    const id = item.get('id')
    if (typeof id === 'string' && id !== '') ids.add(id)
    for (const entry of asInsertItems(item)) {
      if (entry !== null && typeof entry === 'object' && (entry as { disabled?: unknown }).disabled === true) {
        const eid = (entry as { id?: unknown }).id
        if (typeof eid === 'string' && eid !== '') ids.add(eid)
      }
    }
  }
  return ids
}

function asInsertItems(item: YAMLMap): unknown[] {
  const insert = item.get('insert', true)
  return insert instanceof YAMLSeq ? insert.items : []
}

/**
 * 在 home 层追加带 managed 注释的停用裸行（`- id: X` + `disabled: true`）。
 * 幂等：home 层内已停用的 id（任何来源）跳过；返回值只含真正新写入的 id。
 * marker 用于归属（守卫隔离 / 托盘手动停用各自的注释标记）。
 */
export function disableEntries(opts: { dshHome: string; ids: readonly string[]; marker: string }): { written: string[] } {
  const { doc, seq, path } = patchLayerDoc(join(opts.dshHome, 'cordis.patch.yml'))
  const already = disabledIdsInDoc(seq)
  const ours = new Set(seq.items
    .filter((item): item is YAMLMap => item instanceof YAMLMap && (item.commentBefore ?? '').includes(opts.marker))
    .map(item => item.get('id'))
    .filter((id): id is string => typeof id === 'string'))
  const written: string[] = []
  for (const id of opts.ids) {
    if (already.has(id) || ours.has(id)) continue
    const row = new YAMLMap()
    row.set('id', id)
    row.set('disabled', true)
    row.commentBefore = ` --- ${opts.marker} ---`
    seq.items.push(row)
    written.push(id)
  }
  if (written.length === 0) return { written }
  renderAndWrite(doc, seq, path)
  return { written }
}

export function quarantineEntries(opts: { dshHome: string; ids: readonly string[] }): { written: string[] } {
  return disableEntries({ ...opts, marker: QUARANTINE_MARKER })
}

/** 移除全部隔离行（重新启用）；返回被移除的 id。 */
export function removeQuarantine(opts: { dshHome: string }): { removed: string[] } {
  const path = join(opts.dshHome, 'cordis.patch.yml')
  if (!existsSync(path)) return { removed: [] }
  const { doc, seq } = patchLayerDoc(path)
  const removed: string[] = []
  const keep: YAMLSeq['items'] = []
  for (const item of seq.items) {
    if (item instanceof YAMLMap && (item.commentBefore ?? '').includes(QUARANTINE_MARKER)) {
      const id = item.get('id')
      if (typeof id === 'string') removed.push(id)
      continue
    }
    keep.push(item)
  }
  if (removed.length === 0) return { removed }
  seq.items = keep
  renderAndWrite(doc, seq, path)
  return { removed }
}

/**
 * 把 bundle 移出 profile 的 dsh.profile.bundles（bundle 级隔离：其 patch 层整体不再参与组合）。
 * manifest 先整文件备份为 package.json.plugin-guard-bak。已知语义：reconcile 会在之后的
 * 任何成功 `dsh plugin` 操作时把 dependencies 中仍在的 bundle 写回 bundles——移除需每轮
 * preBoot 重申（时序恒在 sidecar 启动前）。manifest 缺失/损坏时 throw，由调用方留痕。
 */
export function quarantineBundles(opts: { dshHome: string; names: readonly string[] }): { written: string[] } {
  const manifestPath = join(opts.dshHome, 'profiles', 'web', 'package.json')
  const original = readFileSync(manifestPath, 'utf8')
  const parsed = JSON.parse(original) as { dsh?: { profile?: { bundles?: unknown } } }
  const bundles = parsed.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) throw new Error(`profile manifest has no dsh.profile.bundles list: ${manifestPath}`)
  const remove = new Set(opts.names)
  const next = bundles.filter((name): name is string => typeof name === 'string' && !remove.has(name))
  const written = bundles.filter((name): name is string => typeof name === 'string' && remove.has(name))
  if (written.length === 0) return { written }
  backupOnce(manifestPath)
  parsed.dsh!.profile!.bundles = next
  writeFileSync(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  return { written }
}

/**
 * 修复无法解析的补丁层：仅处理文件名为 cordis.patch.yml 的用户层/home 层——备份后重置为 []。
 * 其他文件（含 profile package.json、插件包内层）不动，返回值只含被重置的路径。
 */
export function repairCorruptLayers(opts: { dshHome: string; paths: readonly string[] }): { reset: string[] } {
  const reset: string[] = []
  for (const path of opts.paths) {
    if (basename(path) !== 'cordis.patch.yml' || !existsSync(path)) continue
    const doc = parseDocument(readFileSync(path, 'utf8'))
    const parseable = doc.errors.length === 0 && (doc.contents === null || doc.contents instanceof YAMLSeq)
    if (parseable) continue
    backupAlways(path)
    writeFileSync(path, '[]\n', 'utf8')
    reset.push(path)
  }
  return { reset }
}

/**
 * 停用覆盖裸行的判定：`disabled: true` 且键集合 ⊆ {id, name, disabled}。键集合限制是硬约束：
 * dsh-plugin-capabilities 的 legacy 顶层 MCP 行形状为 {id, name, config, disabled}，宽谓词
 * （只看 disabled+无 insert）会把用户 MCP 服务器定义连 config 一起删掉。带 config 或任何
 * 多余键的行不是停用覆盖行，一律不碰。
 */
function isBareDisableRow(item: YAMLMap): boolean {
  if (item.get('disabled') !== true) return false
  const id = item.get('id')
  if (typeof id !== 'string' || id === '') return false
  for (const pair of item.items) {
    const key = String(pair.key)
    if (key !== 'id' && key !== 'name' && key !== 'disabled') return false
  }
  return true
}

/** 从一层删停用裸行（targets 为空 = 全删）。文件不存在/无命中行时不写盘（不惊扰 live watcher）。 */
function stripDisableRows(path: string, targets: ReadonlySet<string> | undefined): string[] {
  if (!existsSync(path)) return []
  const { doc, seq } = patchLayerDoc(path)
  const removed: string[] = []
  const keep: YAMLSeq['items'] = []
  for (const item of seq.items) {
    if (item instanceof YAMLMap && isBareDisableRow(item)) {
      const id = item.get('id') as string
      if (targets === undefined || targets.has(id)) {
        removed.push(id)
        continue
      }
    }
    keep.push(item)
  }
  if (removed.length === 0) return []
  seq.items = keep
  renderAndWrite(doc, seq, path)
  return removed
}

/** 层文件路径（home 层与 profile 用户层——托盘启用/守卫隔离共涉的两层）。 */
function layerPaths(dshHome: string): string[] {
  return [join(dshHome, 'cordis.patch.yml'), join(dshHome, 'profiles', 'web', 'cordis.patch.yml')]
}

/**
 * 启用条目：删 home+profile 两层中这些 id 的一切停用裸行（守卫行、托盘行、页面内插件
 * 管理器写的 {id, name, disabled} 行——不区分来源，否则「启用」会被残留行静默抵消）。
 * insert 行与带 config 的行由 isBareDisableRow 的键集合限制天然不可误伤。
 */
export function enableEntries(opts: { dshHome: string; ids: readonly string[] }): { removed: string[] } {
  const targets = new Set(opts.ids)
  return { removed: layerPaths(opts.dshHome).flatMap(path => stripDisableRows(path, targets)) }
}

/** 全部启用：删两层中全部停用裸行（无 id 过滤，同键集合限制）。 */
export function enableAllEntries(opts: { dshHome: string }): { removed: string[] } {
  return { removed: layerPaths(opts.dshHome).flatMap(path => stripDisableRows(path, undefined)) }
}

/**
 * 把 bundle 加回 profile 的 dsh.profile.bundles（bundle 级隔离的逆操作；guard 只移不还——
 * 恢复入口在托盘，守卫在下次崩溃/预检时会再移出真正损坏者，是安全网）。bundles 只在 boot
 * 读取，调用方写后必须重启 sidecar 才生效。失败契约同 quarantineBundles（manifest 缺失/
 * 无 bundles 列表时 throw）。追加到列表尾部（原次序已随移除丢失）。
 */
export function restoreBundles(opts: { dshHome: string; names: readonly string[] }): { written: string[] } {
  const manifestPath = join(opts.dshHome, 'profiles', 'web', 'package.json')
  const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh?: { profile?: { bundles?: unknown } } }
  const bundles = parsed.dsh?.profile?.bundles
  if (!Array.isArray(bundles)) throw new Error(`profile manifest has no dsh.profile.bundles list: ${manifestPath}`)
  const add = opts.names.filter((name): name is string => typeof name === 'string' && !bundles.includes(name))
  if (add.length === 0) return { written: [] }
  backupOnce(manifestPath)
  parsed.dsh!.profile!.bundles = [...bundles, ...add]
  writeFileSync(manifestPath, `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  return { written: add }
}

/** home+profile 两层中现处停用态的 entry id 并集（供幂等判定与断言）。 */
export function disabledEntryIds(opts: { dshHome: string }): Set<string> {
  const ids = new Set<string>()
  for (const path of [join(opts.dshHome, 'profiles', 'web', 'cordis.patch.yml'), join(opts.dshHome, 'cordis.patch.yml')]) {
    if (!existsSync(path)) continue
    let list: unknown
    try {
      list = parse(readFileSync(path, 'utf8'))
    } catch {
      continue
    }
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue
      const row = item as { id?: unknown; disabled?: unknown; insert?: unknown }
      if (row.disabled === true && typeof row.id === 'string' && row.id !== '') ids.add(row.id)
      if (Array.isArray(row.insert)) {
        for (const entry of row.insert) {
          if (entry === null || typeof entry !== 'object') continue
          const e = entry as { id?: unknown; disabled?: unknown }
          if (e.disabled === true && typeof e.id === 'string' && e.id !== '') ids.add(e.id)
        }
      }
    }
  }
  return ids
}
