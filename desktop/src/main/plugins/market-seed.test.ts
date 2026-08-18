import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { applyMarketConfig, atlasSeeded, bundleSeeded, capabilitiesSeeded, installerSeeded, marketSeeded } from './market-seed'

const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-market-seed-'))
const profileDir = join(root, 'profiles', 'web')
beforeAll(() => { mkdirSync(profileDir, { recursive: true }) })
afterAll(() => rmSync(root, { recursive: true, force: true }))

const manifestWith = (bundles: unknown): string =>
  JSON.stringify({ dsh: { profile: { bundles } } })

describe('marketSeeded', () => {
  it('false when home missing, profile missing, or bundles lacks dshmarket', () => {
    expect(marketSeeded(undefined)).toBe(false)
    expect(marketSeeded(join(root, 'no-such-home'))).toBe(false)
    writeFileSync(join(profileDir, 'package.json'), manifestWith(['@deepseek-ai/dsh-base']))
    expect(marketSeeded(root)).toBe(false)
  })
  it('true once bundles includes dshmarket', () => {
    writeFileSync(join(profileDir, 'package.json'), manifestWith(['@deepseek-ai/dsh-base', 'dshmarket']))
    expect(marketSeeded(root)).toBe(true)
  })
  it('false on unparseable manifest', () => {
    writeFileSync(join(profileDir, 'package.json'), '{ not json')
    expect(marketSeeded(root)).toBe(false)
  })
})

describe('installerSeeded', () => {
  it('tracks dsh-plugin-install independently of dshmarket', () => {
    writeFileSync(join(profileDir, 'package.json'), manifestWith(['@deepseek-ai/dsh-base', 'dshmarket']))
    expect(installerSeeded(root)).toBe(false)
    expect(marketSeeded(root)).toBe(true)
    writeFileSync(join(profileDir, 'package.json'), manifestWith(['@deepseek-ai/dsh-base', 'dshmarket', 'dsh-plugin-install']))
    expect(installerSeeded(root)).toBe(true)
  })
  it('false on missing home', () => {
    expect(installerSeeded(undefined)).toBe(false)
    expect(bundleSeeded(join(root, 'no-such-home'), 'dshmarket')).toBe(false)
  })
})

describe('capabilitiesSeeded', () => {
  it('tracks dsh-plugin-capabilities independently of the other seeds', () => {
    writeFileSync(join(profileDir, 'package.json'), manifestWith(['@deepseek-ai/dsh-base', 'dshmarket', 'dsh-plugin-install']))
    expect(capabilitiesSeeded(root)).toBe(false)
    expect(installerSeeded(root)).toBe(true)
    writeFileSync(join(profileDir, 'package.json'), manifestWith(['@deepseek-ai/dsh-base', 'dshmarket', 'dsh-plugin-install', 'dsh-plugin-capabilities']))
    expect(capabilitiesSeeded(root)).toBe(true)
  })
  it('false on missing home', () => {
    expect(capabilitiesSeeded(undefined)).toBe(false)
    expect(capabilitiesSeeded(join(root, 'no-such-home'))).toBe(false)
  })
})

describe('atlasSeeded', () => {
  it('tracks dsh-plugin-atlas independently of the other seeds', () => {
    writeFileSync(join(profileDir, 'package.json'), manifestWith(['@deepseek-ai/dsh-base', 'dshmarket', 'dsh-plugin-install', 'dsh-plugin-capabilities']))
    expect(atlasSeeded(root)).toBe(false)
    expect(capabilitiesSeeded(root)).toBe(true)
    writeFileSync(join(profileDir, 'package.json'), manifestWith(['@deepseek-ai/dsh-base', 'dshmarket', 'dsh-plugin-install', 'dsh-plugin-capabilities', 'dsh-plugin-atlas']))
    expect(atlasSeeded(root)).toBe(true)
  })
  it('false on missing home', () => {
    expect(atlasSeeded(undefined)).toBe(false)
    expect(atlasSeeded(join(root, 'no-such-home'))).toBe(false)
  })
})

describe('applyMarketConfig', () => {
  it('appends the override to the upstream `[]` template, preserving comments', () => {
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '# comment line\n[]\n')
    applyMarketConfig(profileDir)
    const content = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    expect(content).toContain('# comment line')
    expect(content).not.toMatch(/^\[\]$/m)
    expect(content).toContain('- id: dsh-market')
    expect(content).toContain('allowRestart: false')
  })
  it('is idempotent — a second call adds no second row', () => {
    applyMarketConfig(profileDir)
    const content = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    expect(content.match(/^- id: dsh-market$/gm)).toHaveLength(1)
  })
  it('appends after existing user rows and stays idempotent', () => {
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '- id: something-else\n  config: {a: 1}\n')
    applyMarketConfig(profileDir)
    applyMarketConfig(profileDir)
    const content = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    expect(content).toContain('- id: something-else')
    expect(content.match(/^- id: dsh-market$/gm)).toHaveLength(1)
  })
})
