import { describe, expect, it } from 'vitest'
import { resolveRuntime } from './runtime-resolver'

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
