import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import type { RuntimeMode } from '../sidecar/runtime-resolver'
import { parseInstalledPlugins } from './installed-list'
import { pluginCommand } from './plugin-runner'
import { ensurePnpmShim, prependPath } from './pnpm-shim'

/** 插件管理后端（设计书 §7）。 */
export class PluginManager {
  constructor(private readonly opts: {
    mode: RuntimeMode
    execPath: string
    repoRoot: string
    dshHome: string | undefined
    sidecarEnv: NodeJS.ProcessEnv
    shimDir: string
    resolvePnpmCli: () => string
    onOutput: (line: string) => void
    restartSidecar: () => void
  }) {}

  async run(pnpmArgs: string[]): Promise<number> {
    const { command, args, cwd } = pluginCommand({ mode: this.opts.mode, execPath: this.opts.execPath, repoRoot: this.opts.repoRoot })
    const shimDir = await ensurePnpmShim({ execPath: this.opts.execPath, shimDir: this.opts.shimDir, resolvePnpmCli: this.opts.resolvePnpmCli })
    const env: NodeJS.ProcessEnv = { ...this.opts.sidecarEnv, PATH: prependPath(this.opts.sidecarEnv.PATH ?? '', shimDir) }
    const child = spawn(command, [...args, ...pnpmArgs], { cwd: cwd ?? process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [child.stdout, child.stderr]) {
      if (stream !== null) createInterface({ input: stream }).on('line', (line) => this.opts.onOutput(line))
    }
    return await new Promise<number>((resolve) => {
      // close（而非 exit）：等 stdio 排空，避免退出码行抢在最后几行输出之前。
      child.once('close', (code) => resolve(code ?? 1))
      // spawn 失败（cwd 无效、入口缺失等）只发 error 不发 exit：必须兜底 resolve，否则永久挂起。
      child.once('error', (error) => { this.opts.onOutput(String(error)); resolve(1) })
    })
  }

  listInstalled(): string[] {
    if (this.opts.dshHome === undefined) return []
    const manifest = join(this.opts.dshHome, 'profiles', 'web', 'package.json')
    if (!existsSync(manifest)) return []
    return parseInstalledPlugins(readFileSync(manifest, 'utf8'))
  }
}
