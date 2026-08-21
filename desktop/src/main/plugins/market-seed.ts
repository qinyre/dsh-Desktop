import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import { parse, parseDocument, YAMLMap, YAMLSeq } from 'yaml'
import { resolveRuntime, type RuntimeMode } from '../sidecar/runtime-resolver'

/** 预装的市场版本：只在预装时钉住，市场自身可在设置页走更新通道升级。 */
export const DSHMARKET_SPEC = 'dshmarket@1.11.2'

/**
 * 预装的插件安装器版本（qinyre/dsh-plugin-install）：同样只在预装时钉住。
 * 0.2.0 起该标签页兼做更新器（检查更新/一键升级），并带「重启服务」按钮：
 * 桌面模式下经 dsh:restart-sidecar IPC 交回壳层（见 index.ts），无需任何
 * patch 配置覆盖——与市场不同，它没有脱离监督的自重启路径。
 * 0.2.1 起：安装/更新/卸载失败一律以 200 携带结果体返回并由页面渲染
 * 红色横幅（此前命令失败会被当成 HTTP 错误抛掉，页面毫无反馈）。
 * 0.2.2 起：发布后秒点更新撞上的 ERR_PNPM_NO_VERSIONS（registry 元数据
 * 传播竞态）自动延时重试一次，仍失败则横幅附「稍候重试」提示。
 * 0.2.3 起：安装/更新绕过 pnpm 11 默认的 24 小时发布冷静期（minimumReleaseAge
 * 会把裸名/@latest 静默解析到窗口外旧版，更新看似成功实则原地不动），并在
 * 更新完成后核对实际落地的版本号。
 * 0.2.4 起：卸载同样绕过冷静期——pnpm 11 对整个 lockfile 做策略校验，只要
 * 有窗口内发布的条目（如钉版安装的传递依赖），remove 也会被一并拦死；
 * 失败横幅带出 pnpm 打在标准输出里的真实诊断。
 * 0.3.0 起：后台定时自动检查更新（30 分钟节奏，设置页「插件」旁常显可更新
 * 数角标）；插件卡片带简短描述与「源码」标签；新增停用/挂载开关（经 profile
 * 的 cordis.patch.yml 裸行 disabled 覆盖，层被 live watch，实时生效且不动
 * bundles 清单）；独立 dsh 下「重启服务」按钮做实（分离接力进程等待端口
 * 释放后按原 argv 重启自身）。
 * 0.3.1 起：停用/挂载改为经 YAML 文档树重写补丁层——dsh 自己写入的流式行
 * （MCP 配置）会让 0.3.0 的按行拼接产出无法解析的文件：实时重载静默失效
 * （停用看似无效）、下次启动直接解析报错。0.3.0 写坏的层会被自动修复且保留
 * 全部停用状态；node 产物带 createRequire banner（内联的 yaml 包是 CJS，
 * 动态 require 在 ESM 产物里导入即崩），verify-bundle 补上 node 半边导入自检。
 * 0.3.2 起：打开安装页自动检查一次更新（非强制，吃服务端 30 分钟 TTL 缓存），
 * 可更新提示与「更新」按钮无需再手动点「检查更新」才出现。
 * 0.3.3 起：安装命令链自带 windowsHide——独立 dsh 的运行时没有桌面的防弹窗
 * 补丁层，装插件时 cmd shim 链（安装器拉 dsh、转发器拉 pnpm）会在无控制台
 * 宿主下各弹一个 cmd 窗；第一层隐藏后整条子链继承，桌面端该 flag 为冗余但无害。
 * 0.3.4 起：自重启感知终端——从交互终端启动的 dsh 重启后新进程接管原终端
 * （同一窗口、Ctrl+C 照常可杀），不再脱逃成隐藏孤儿；管道宿主（桌面 sidecar）
 * 仍走原分离路径。
 * 0.3.5 起：重启落地方式改为专属控制台窗口——实测本机进程管控会在父进程退出
 * 时连带杀死一切非分离子进程（纯净环境验证，与 dsh 无关），任何「由旧进程派生
 * 并依赖其存活」的接管方案都必然随旧进程陪葬；故 relay 回归分离（等旧进程真正
 * 释放端口后再拉起，重 profile 的 dispose 时长不再构成竞态），successor 落在
 * 标题为「dsh web」的独立窗口里，终止它就在该窗口 Ctrl+C 或直接关窗；管道
 * 宿主维持隐藏分离路径不变。
 */
export const INSTALLER_SPEC = 'dsh-plugin-install@0.3.5'

/**
 * 预装的能力管理插件版本（qinyre/dsh-plugin-capabilities，设置页一级分区「技能与 MCP」，
 * 与通用设置/模型同级，内含「技能」「MCP」「市场」三个标签页）。0.2.0 起新增：逐技能
 * 开关加载、手动注册本地/GitHub 技能仓库、技能与 MCP 两个精选市场；0.3.0 起市场条目
 * 可点开详情（技能清单、MCP 启动命令/环境变量/工具清单）；0.3.1 起收录扩容（技能仓库
 * 8 个、MCP 服务器 16 个）且详情为双语长文 + 逐技能简介；0.3.2 详情弹窗加宽到 720px
 * 并改为内部滚动（宿主弹窗固定 380px 细柱，长文会被裁切）；0.3.3 编辑弹窗再加宽到 760px，正文区新增 Markdown 预览与纯文本编辑切换（预览走宿主 MarkdownText）；0.3.4 起
 * custom 来源技能可就地编辑（预览自带 marked+DOMPurify）；0.3.5 起删除技能仓库改为
 * 先卸载 provider 的目录监听再删树（Windows 上删被 watch 目录必 EPERM）。
 * 同样只在预装时钉住；无需 patch 覆盖——待重启横幅在桌面模式下经 dsh:restart-sidecar
 * IPC 交回壳层。
 */
export const CAPABILITIES_SPEC = 'dsh-plugin-capabilities@0.3.5'

/**
 * 预装的归档与刻度尺插件版本（qinyre/dsh-plugin-atlas，设置页一级分区「归档管理」
 * + 对话区左缘的鱼眼刻度尺；0.2.0 起管理面板从侧边栏抽屉迁入设置页，0.2.1 起输入框 ↑/↓
 * 翻找输入历史，0.2.2 起切换会话时历史回填改为空闲帧步进、↑/↓ 仅在光标位于文本
 * 开头/末尾时触发）。纯 HTTP 路由
 * 与 UI 扩展，无重启、无自更新路径，无需任何 patch 配置覆盖。同样只在预装时钉住。
 */
export const ATLAS_SPEC = 'dsh-plugin-atlas@0.2.2'

/** profile 是否已收录指定 bundle：以 dsh.profile.bundles 为准（reconcile 的落点）。 */
export function bundleSeeded(dshHome: string | undefined, name: string): boolean {
  if (dshHome === undefined) return false
  const manifest = join(dshHome, 'profiles', 'web', 'package.json')
  if (!existsSync(manifest)) return false
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { dsh?: { profile?: { bundles?: unknown } } }
    const bundles = parsed.dsh?.profile?.bundles
    return Array.isArray(bundles) && bundles.includes(name)
  } catch {
    return false
  }
}

/** profile 是否已装市场。 */
export function marketSeeded(dshHome: string | undefined): boolean {
  return bundleSeeded(dshHome, 'dshmarket')
}

/** profile 是否已装插件安装器。 */
export function installerSeeded(dshHome: string | undefined): boolean {
  return bundleSeeded(dshHome, 'dsh-plugin-install')
}

/** profile 是否已装能力管理插件（技能/MCP）。 */
export function capabilitiesSeeded(dshHome: string | undefined): boolean {
  return bundleSeeded(dshHome, 'dsh-plugin-capabilities')
}

/** profile 是否已装归档与刻度尺插件。 */
export function atlasSeeded(dshHome: string | undefined): boolean {
  return bundleSeeded(dshHome, 'dsh-plugin-atlas')
}

/**
 * 经 dsh CLI 预装 bundle，而非裸 pnpm：CLI 侧自带 profile 初始化（首启时 profile
 * 尚不存在）与 reconcile（把声明 bundle 的依赖写回 dsh.profile.bundles）。命令形态与
 * sidecar 完全一致（resolveRuntime），市场的 dshArgv() 在运行期重调 CLI 时也依赖同一形态。
 * `add` 后的 spec 原样透传 pnpm，多 spec 即一次安装（上游 args.ts 不截参数）。
 */
export async function seedBundle(opts: {
  mode: RuntimeMode
  execPath: string
  repoRoot: string
  env: NodeJS.ProcessEnv
  resolve?: (id: string) => string
  specs: readonly string[]
  onOutput?: (line: string) => void
}): Promise<number> {
  const { command, args, cwd } = resolveRuntime({
    mode: opts.mode, execPath: opts.execPath, repoRoot: opts.repoRoot, resolve: opts.resolve,
    dshArgs: ['plugin', '--profile', 'web', 'add', ...opts.specs],
  })
  const child = spawn(command, args, { cwd: cwd ?? process.cwd(), env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [child.stdout, child.stderr]) {
    if (stream !== null) createInterface({ input: stream }).on('line', (line) => opts.onOutput?.(line))
  }
  return await new Promise<number>((resolve) => {
    // close（而非 exit）：等 stdio 排空；spawn 失败只发 error 不发 exit，须兜底防挂起。
    child.once('close', (code) => resolve(code ?? 1))
    child.once('error', (error) => { opts.onOutput?.(String(error)); resolve(1) })
  })
}

/** 一个预装位：name/spec 供日志与进度，seeded 为调用时的就位检查，装好后回调 onSeeded。 */
export interface SeedStep {
  name: string
  spec: string
  seeded: boolean
  onSeeded?: () => void
}

/**
 * 预装编排：把未就位的插件合并成一次 `dsh plugin add`——一次 CLI 引导 + 一次 pnpm
 * 安装 + 一次 reconcile，替代旧的四次串行全链引导。pnpm 的多 spec add 是原子的：
 * 一个 spec 解析失败会拖垮整批，所以批量失败时回退逐个安装，保住健康的 spec
 * （与旧的逐个预装行为对齐）。已就位的一律跳过；单个失败不重试，留给下次启动。
 */
export async function seedPendingPlugins(opts: {
  steps: readonly SeedStep[]
  run: (specs: string[]) => Promise<number>
  log?: (line: string) => void
  onProgress?: (progress: { phase: 'batch' | 'step'; current: string; done: number; total: number }) => void
}): Promise<void> {
  const missing = opts.steps.filter((step) => !step.seeded)
  if (missing.length === 0) return
  const specs = missing.map((step) => step.spec)
  const total = missing.length
  opts.log?.(`seeding plugins: ${specs.join(', ')}`)
  opts.onProgress?.({ phase: 'batch', current: specs.join(', '), done: 0, total })
  const code = await opts.run(specs)
  if (code === 0) {
    for (const step of missing) step.onSeeded?.()
    return
  }
  if (total === 1) {
    opts.log?.(`${missing[0]!.name} seed failed (exit ${code}); retrying next launch`)
    return
  }
  opts.log?.(`batched seed failed (exit ${code}); falling back to one-by-one`)
  for (const [index, step] of missing.entries()) {
    opts.onProgress?.({ phase: 'step', current: step.spec, done: index + 1, total })
    if (await opts.run([step.spec]) === 0) {
      step.onSeeded?.()
    } else {
      opts.log?.(`${step.name} seed failed; retrying next launch`)
    }
  }
}

/** 市场行 id（其自带 cordis.patch.yml 的 insert id），配置覆盖以此为目标。 */
const MARKET_ENTRY_ID = 'dsh-market'

/**
 * 在 profile 自有 patch 层追加市场配置覆盖：关掉自重启。市场的 scheduleRestart 会经
 * 脱管 helper spawn 替代 dsh 进程再退出自身——在桌面应用的 sidecar 监督下这会留下一个
 * 无人认领的进程并触发监督器重生（双进程）；重启由应用层（sidecar.restart）负责。
 *
 * 改层必须走 YAML 文档树、整层重渲染为 block 风格：dsh 自己会往层里写 flow 式行
 * （MCP 配置），行级拼接会在 flow 根后追加 block 行产出非法 YAML（installer 0.3.0
 * 事故的同款坑）。解析失败的层直接抛错且不落盘——写前先验证产物可解析，绝不写坏层。
 */
export function applyMarketConfig(profileDir: string): void {
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const content = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
  const doc = parseDocument(content)
  if (doc.errors.length > 0) {
    throw new Error(`cordis.patch.yml does not parse: ${doc.errors[0]?.message ?? String(doc.errors[0])}`)
  }
  if (doc.contents !== null && !(doc.contents instanceof YAMLSeq)) {
    throw new Error('cordis.patch.yml: root is not a list of patch rows')
  }
  // 新建节点没有 source range，塞不进 ParsedNode 型的 contents，与 installer 同款 as never。
  const seq: YAMLSeq = doc.contents instanceof YAMLSeq ? doc.contents : new YAMLSeq() as never
  if (doc.contents === null) doc.contents = seq as never
  for (const item of seq.items) {
    if (item instanceof YAMLMap && item.get('id') === MARKET_ENTRY_ID) return
  }
  const config = new YAMLMap()
  config.set('allowRestart', false)
  const row = new YAMLMap()
  row.set('id', MARKET_ENTRY_ID)
  row.set('config', config)
  row.commentBefore = ' dsh-desktop: 市场的自重启会在应用监督外 spawn 替代进程，重启交由应用层负责。'
  seq.items.push(row)
  setBlockStyle(seq)
  const next = doc.toString({ lineWidth: 0 })
  parse(next) // 写前自检：live watcher 与下次启动都对这个文件 fail loud，绝不落盘可能解析失败的层
  writeFileSync(patchPath, next, 'utf8')
}

/** 渲染为 block 风格（flow 根无法接 block 追加）；标量值按需重新引号。 */
function setBlockStyle(node: unknown): void {
  if (node instanceof YAMLMap) {
    node.flow = false
    for (const pair of node.items) setBlockStyle(pair.value)
  } else if (node instanceof YAMLSeq) {
    node.flow = false
    for (const item of node.items) setBlockStyle(item)
  }
}
