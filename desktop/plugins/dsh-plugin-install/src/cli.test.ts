import { describe, expect, it } from 'vitest'
import { validateSpec } from './cli.ts'

describe('validateSpec（防注入：任意下载的入口）', () => {
  it('accepts bare package names', () => {
    expect(validateSpec('dsh-context')).toBeNull()
    expect(validateSpec('@deepseek-ai/dsh-host-apiproxy')).toBeNull()
  })

  it('accepts versioned and git specs', () => {
    expect(validateSpec('dsh-context@^1.2.3')).toBeNull()
    expect(validateSpec('dsh-context@~1.2')).toBeNull()
    expect(validateSpec('dsh-context@=1.2.3')).toBeNull()
    expect(validateSpec('dsh-context@latest')).toBeNull()
    expect(validateSpec('github:user/repo')).toBeNull()
    expect(validateSpec('github:user/repo#a1b2c3d')).toBeNull()
  })

  it('accepts local file and link specs', () => {
    expect(validateSpec('file:../hello-plugin')).toBeNull()
    expect(validateSpec('link:./packages/foo')).toBeNull()
  })

  it('rejects empty and oversized specs', () => {
    expect(validateSpec('')).not.toBeNull()
    expect(validateSpec('x'.repeat(201))).not.toBeNull()
  })

  it('rejects argument injection (leading dash)', () => {
    expect(validateSpec('-S')).not.toBeNull()
    expect(validateSpec('--global-dir一起来')).not.toBeNull()
  })

  it('rejects shell metacharacters', () => {
    for (const spec of ['a; rm -rf /', 'a && b', '$(ls)', '`id`', 'a|b', 'a>out', 'a b c']) {
      expect(validateSpec(spec), spec).not.toBeNull()
    }
  })

  it('rejects whitespace inside the spec', () => {
    expect(validateSpec('dsh context')).not.toBeNull()
  })
})