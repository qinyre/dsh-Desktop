import { resolveRuntime, type RuntimeMode } from '../sidecar/runtime-resolver'

/** dsh plugin 子命令入口拼装（设计书 §7）。 */
export function pluginCommand(opts: { mode: RuntimeMode; execPath: string; repoRoot: string; resolve?: (id: string) => string }): {
  command: string; args: string[]; cwd: string | undefined
} {
  return resolveRuntime({ ...opts, dshArgs: ['plugin', '--profile', 'web'] })
}
