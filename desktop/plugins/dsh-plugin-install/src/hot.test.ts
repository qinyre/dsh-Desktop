import { describe, expect, it } from 'vitest'
import { parseSimplePatch } from './hot.ts'

describe('parseSimplePatch（热载可行性判断）', () => {
  it('parses a plain insert block', () => {
    const rows = parseSimplePatch(`- insert:\n    - id: hello\n      name: dsh-hello-plugin\n`)
    expect(rows).toEqual([{ id: 'hello', name: 'dsh-hello-plugin' }])
  })

  it('parses multiple rows in one insert', () => {
    const rows = parseSimplePatch(`- insert:\n    - id: a\n      name: pkg-a\n    - id: b\n      name: pkg-b\n`)
    expect(rows).toHaveLength(2)
  })

  it('accepts quoted names and comments', () => {
    const rows = parseSimplePatch(`# comment\n- insert:\n    - id: a\n      name: 'pkg-a'  # trailing\n`)
    expect(rows).toEqual([{ id: 'a', name: 'pkg-a' }])
  })

  it('rejects config-bearing rows (fall back to restart)', () => {
    expect(parseSimplePatch(`- insert:\n    - id: a\n      name: pkg-a\n      config:\n        x: 1\n`)).toBeNull()
  })

  it('rejects disable rows and free patches', () => {
    expect(parseSimplePatch(`- id: a\n  disabled: true\n`)).toBeNull()
    expect(parseSimplePatch(`[]`)).toBeNull()
    expect(parseSimplePatch(``)).toBeNull()
  })

  it('rejects a dangling id without a name', () => {
    expect(parseSimplePatch(`- insert:\n    - id: a\n- insert:\n    - id: b\n      name: c\n`)).toBeNull()
  })
})