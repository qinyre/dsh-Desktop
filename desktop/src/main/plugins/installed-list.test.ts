import { describe, expect, it } from 'vitest'
import { parseInstalledPlugins, WEB_PROFILE_BASELINE } from './installed-list'

describe('parseInstalledPlugins（设计书 §7：bundles − 模板基线）', () => {
  it('lists user plugins only (scoped template baseline, per upstream PROFILE_TEMPLATES.web)', () => {
    const manifest = JSON.stringify({ dependencies: { 'some-plain-lib': '1.0.0' }, dsh: { profile: { bundles: [...WEB_PROFILE_BASELINE, 'dsh-plugin-x'] } } })
    expect(parseInstalledPlugins(manifest)).toEqual(['dsh-plugin-x'])
  })
  it('honors an explicit baseline override', () => {
    const manifest = JSON.stringify({ dsh: { profile: { bundles: ['dsh-base', 'dsh-plugin-x'] } } })
    expect(parseInstalledPlugins(manifest, ['dsh-base'])).toEqual(['dsh-plugin-x'])
  })
  it('missing manifest fields and corrupt json yield empty list', () => {
    expect(parseInstalledPlugins('{}')).toEqual([])
    expect(parseInstalledPlugins('{oops')).toEqual([])
  })
})
