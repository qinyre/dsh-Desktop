import { describe, expect, it } from 'vitest'
import { resolveRuntime, toUnpackedPath } from './runtime-resolver'

const exec = '/fake/electron.exe'
const repo = '/fake/deepseek-harness'

describe('resolveRuntime', () => {
  it('source mode loads the repo CLI through the tsx ESM hook with repo cwd', () => {
    const rt = resolveRuntime({ mode: 'source', execPath: exec, repoRoot: repo, dshArgs: ['web', '--port', '0', '--host', '127.0.0.1'] })
    expect(rt).toEqual({
      command: exec,
      args: ['--expose-internals', '--import', 'tsx/esm', `${repo}/apps/cli/src/bin.ts`, 'web', '--port', '0', '--host', '127.0.0.1'],
      cwd: repo,
    })
  })
  it('npm mode runs the bundled dsh bin, mapping asar to unpacked', () => {
    const resolve = (id: string) => (id === '@deepseek-ai/dsh/package.json' ? '/app.asar/node_modules/@deepseek-ai/dsh/package.json' : '/app.asar/node_modules/@deepseek-ai/dsh/lib/bin.js')
    const rt = resolveRuntime({ mode: 'npm', execPath: exec, repoRoot: repo, dshArgs: ['web'], resolve })
    expect(rt.args[0]).toBe('--expose-internals')
    expect(rt.args[1]).toBe('/app.asar.unpacked/node_modules/@deepseek-ai/dsh/lib/bin.js')
    expect(rt.cwd).toBeUndefined()
  })
})

describe('toUnpackedPath（终审 Critical #1 回归：打包路径必须出 asar）', () => {
  it('maps asar-resolved pnpm cli paths to app.asar.unpacked', () => {
    // index.ts resolvePnpmCli 的两条解析路径（package.json 锚点拼接 / 老版 pnpm 直接
    // 子路径）在打包后都产出 app.asar 内的 pnpm.cjs；shim 以 ELECTRON_RUN_AS_NODE
    // 纯 Node 跑它，读不了 asar——必须映射到解包目录。
    expect(toUnpackedPath('/app.asar/node_modules/pnpm/bin/pnpm.cjs')).toBe('/app.asar.unpacked/node_modules/pnpm/bin/pnpm.cjs')
    expect(toUnpackedPath('C:\\app.asar\\node_modules\\pnpm\\bin\\pnpm.cjs')).toBe('C:\\app.asar.unpacked\\node_modules\\pnpm\\bin\\pnpm.cjs')
  })
  it('leaves dev paths (no asar segment) untouched', () => {
    expect(toUnpackedPath('/repo/desktop/node_modules/pnpm/bin/pnpm.cjs')).toBe('/repo/desktop/node_modules/pnpm/bin/pnpm.cjs')
  })
})
