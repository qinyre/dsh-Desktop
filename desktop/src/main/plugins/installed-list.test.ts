import { describe, expect, it } from 'vitest'
import { parseInstalledPlugins } from './installed-list'

describe('parseInstalledPlugins（设计书 §7：bundles − 模板基线）', () => {
  it('lists user plugins only', () => {
    const manifest = JSON.stringify({ dependencies: { 'some-plain-lib': '1.0.0' }, dsh: { profile: { bundles: ['dsh-base', 'dsh-web-app', 'dsh-plugin-x'] } } })
    expect(parseInstalledPlugins(manifest)).toEqual(['dsh-plugin-x'])
  })
  it('missing manifest fields and corrupt json yield empty list', () => {
    expect(parseInstalledPlugins('{}')).toEqual([])
    expect(parseInstalledPlugins('{oops')).toEqual([])
  })
})
