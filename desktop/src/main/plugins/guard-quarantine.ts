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

function backup(path: string): void {
  const bak = path + BACKUP_SUFFIX
  rmSync(bak, { force: true })
  copyFileSync(path, bak)
}

/** 打开（或初始化）home patch 层的文档树；无法解析时 throw——绝不落盘可能写坏的层。 */
function homePatchDoc(dshHome: string): { doc: ReturnType<typeof parseDocument>; seq: YAMLSeq; path: string } {
  const path = join(dshHome, 'cordis.patch.yml')
  const content = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const doc = parseDocument(content)
  if (doc.errors.length > 0) {
    throw new Error(`home cordis.patch.yml does not parse: ${doc.errors[0]?.message ?? String(doc.errors[0])}`)
  }
  if (doc.contents !== null && !(doc.contents instanceof YAMLSeq)) {
    throw new Error('home cordis.patch.yml: root is not a list of patch rows')
  }
  const seq: YAMLSeq = doc.contents instanceof YAMLSeq ? doc.contents : new YAMLSeq() as never
  if (doc.contents === null) doc.contents = seq as never
  return { doc, seq, path }
}

function renderAndWrite(doc: ReturnType<typeof parseDocument>, seq: YAMLSeq, path: string): void {
  setBlockStyle(seq)
  const next = doc.toString({ lineWidth: 0 })
  parse(next) // 写前自检：live watcher 与下次启动都对此文件 fail loud
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
 * 在 home 层追加隔离行（`- id: X` + `disabled: true`，带 managed 块注释）。
 * 幂等：home 层内已停用的 id 跳过；返回值只含真正新写入的 id。
 */
export function quarantineEntries(opts: { dshHome: string; ids: readonly string[] }): { written: string[] } {
  const { doc, seq, path } = homePatchDoc(opts.dshHome)
  const already = disabledIdsInDoc(seq)
  const ours = new Set(seq.items
    .filter((item): item is YAMLMap => item instanceof YAMLMap && (item.commentBefore ?? '').includes(QUARANTINE_MARKER))
    .map(item => item.get('id'))
    .filter((id): id is string => typeof id === 'string'))
  const written: string[] = []
  for (const id of opts.ids) {
    if (already.has(id) || ours.has(id)) continue
    const row = new YAMLMap()
    row.set('id', id)
    row.set('disabled', true)
    row.commentBefore = ` --- ${QUARANTINE_MARKER} ---`
    seq.items.push(row)
    written.push(id)
  }
  if (written.length === 0) return { written }
  renderAndWrite(doc, seq, path)
  return { written }
}

/** 移除全部隔离行（重新启用）；返回被移除的 id。 */
export function removeQuarantine(opts: { dshHome: string }): { removed: string[] } {
  if (!existsSync(join(opts.dshHome, 'cordis.patch.yml'))) return { removed: [] }
  const { doc, seq, path } = homePatchDoc(opts.dshHome)
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
  backup(manifestPath)
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
    backup(path)
    writeFileSync(path, '[]\n', 'utf8')
    reset.push(path)
  }
  return { reset }
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
