import { join, sep } from 'node:path'

export type RuntimeMode = 'source' | 'npm'

export interface ResolvedRuntime {
  command: string
  args: string[]
  cwd: string | undefined
}

/**
 * Assemble the sidecar/plugin child command (设计书 §3/§10)。
 * source：tsx ESM hook 加载仓库 CLI（AGENTS.md 的 source-launch 契约），cwd=仓库根。
 * npm：捆绑包 lib/bin.js；ELECTRON_RUN_AS_NODE 的纯 Node 读不了 asar，路径必须映射到 app.asar.unpacked。
 * 两种模式都前置 --expose-internals：dsh web profile 的 cordis-plugin-hmr 需要 Node 内部
 * 模块。dev 冒烟（纯 Node）走 node-addon-require-builtin 探测兜底也能活；但 GUI 下子进程
 * 是 Electron-as-Node，该 addon 的 realm 探测在 Electron embedder data 下失败（实测
 * "Unsupported/no-realm"），唯有显式 flag 才能让 loader.internal 命中 require 路径。
 */
export function resolveRuntime(opts: {
  mode: RuntimeMode
  execPath: string
  repoRoot: string
  dshArgs: readonly string[]
  resolve?: (id: string) => string
}): ResolvedRuntime {
  if (opts.mode === 'source') {
    // 归一为 `/`：win32 的 join 会产生 `\`，而 ELECTRON_RUN_AS_NODE 子进程在 Windows 上
    // 同样接受正斜杠路径；契约（测试/调用方）统一使用 POSIX 分隔符。
    const entry = join(opts.repoRoot, 'apps/cli/src/bin.ts').split(sep).join('/')
    return {
      command: opts.execPath,
      args: ['--expose-internals', '--import', 'tsx/esm', entry, ...opts.dshArgs],
      cwd: opts.repoRoot,
    }
  }
  const resolve = opts.resolve ?? ((id: string) => require.resolve(id))
  const pkgPath = resolve('@deepseek-ai/dsh/package.json')
  const entry = resolve('@deepseek-ai/dsh/lib/bin.js')
  const unpacked = (p: string): string => p.replace('app.asar', 'app.asar.unpacked')
  void pkgPath // 存在性校验：解析失败会抛错，即"未捆绑 dsh"在设计书上要求 fail loud
  return { command: opts.execPath, args: ['--expose-internals', unpacked(entry), ...opts.dshArgs], cwd: undefined }
}
