import { describe, expect, it } from 'vitest'
import { pluginCommand } from './plugin-runner'

describe('pluginCommand', () => {
  it('assembles dsh plugin entry with profile web', () => {
    const cmd = pluginCommand({ mode: 'source', execPath: '/e', repoRoot: '/repo' })
    expect(cmd.args.slice(-2)).toEqual(['plugin', '--profile', 'web'].slice(-2))
    expect(cmd.args).toContain('plugin')
    expect(cmd.args).toContain('--profile')
    expect(cmd.args).toContain('web')
  })
})
