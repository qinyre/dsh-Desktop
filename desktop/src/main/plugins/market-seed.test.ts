import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { applyMarketConfig, atlasSeeded, bundleSeeded, capabilitiesSeeded, installerSeeded, marketSeeded, seedPendingPlugins } from './market-seed'

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
  it('rewrites a dsh-written flow-style root instead of appending block rows after it', () => {
    // dsh 自己往层里写 flow 式行（MCP 配置）：flow 根后直接追加 block 行产出
    // 非法 YAML（installer 0.3.0 事故同款），必须经文档树重写为 block 风格。
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '[ { id: mcp-foo, url: "http://127.0.0.1:9" } ]\n')
    applyMarketConfig(profileDir)
    const content = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    expect(() => parse(content)).not.toThrow()
    expect(content).toContain('id: mcp-foo')
    expect(content).toContain('- id: dsh-market')
    expect(content).toContain('allowRestart: false')
  })
  it('throws and leaves the file untouched when the layer does not parse', () => {
    const broken = 'insert: [unclosed\n  - bad\n'
    writeFileSync(join(profileDir, 'cordis.patch.yml'), broken)
    expect(() => applyMarketConfig(profileDir)).toThrow()
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe(broken)
  })
  it('creates a valid layer from a comments-only file', () => {
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '# only a comment\n')
    applyMarketConfig(profileDir)
    const content = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    expect(() => parse(content)).not.toThrow()
    expect(content).toContain('# only a comment')
    expect(content).toContain('- id: dsh-market')
  })
  it('treats a quoted existing id as already present', () => {
    writeFileSync(join(profileDir, 'cordis.patch.yml'), "- id: 'dsh-market'\n  config: {allowRestart: false}\n")
    applyMarketConfig(profileDir)
    const content = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    expect(content.match(/- id: '?dsh-market'?/g)).toHaveLength(1)
  })
})

describe('seedPendingPlugins', () => {
  const step = (name: string, seeded: boolean, onSeeded?: () => void) => ({ name, spec: `${name}@1.0.0`, seeded, onSeeded })

  it('runs nothing when every plugin is already seeded', async () => {
    const runs: string[][] = []
    await seedPendingPlugins({
      steps: [step('a', true), step('b', true)],
      run: async (specs) => { runs.push(specs); return 0 },
    })
    expect(runs).toEqual([])
  })

  it('installs all missing plugins in one batched call and fires their callbacks', async () => {
    const runs: string[][] = []
    const done: string[] = []
    await seedPendingPlugins({
      steps: [step('a', true), step('b', false, () => { done.push('b') }), step('c', false, () => { done.push('c') })],
      run: async (specs) => { runs.push(specs); return 0 },
    })
    expect(runs).toEqual([['b@1.0.0', 'c@1.0.0']])
    expect(done).toEqual(['b', 'c'])
  })

  it('falls back to one-by-one when the batch fails, keeping individually healthy specs', async () => {
    const runs: string[][] = []
    const done: string[] = []
    await seedPendingPlugins({
      steps: [step('a', false, () => { done.push('a') }), step('b', false, () => { done.push('b') }), step('c', false, () => { done.push('c') })],
      run: async (specs) => {
        runs.push(specs)
        return specs.includes('b@1.0.0') ? 1 : 0 // 批量与单装 b 都失败（如 registry 抖动）
      },
    })
    expect(runs).toEqual([['a@1.0.0', 'b@1.0.0', 'c@1.0.0'], ['a@1.0.0'], ['b@1.0.0'], ['c@1.0.0']])
    expect(done).toEqual(['a', 'c'])
  })

  it('does not retry a lone failing plugin', async () => {
    const runs: string[][] = []
    await seedPendingPlugins({
      steps: [step('a', false)],
      run: async (specs) => { runs.push(specs); return 1 },
    })
    expect(runs).toEqual([['a@1.0.0']])
  })
})

describe('seedPendingPlugins progress', () => {
  it('reports one batch event, then per-step events during fallback', async () => {
    const events: string[] = []
    const track = (p: { phase: string; current: string; done: number; total: number }) => {
      events.push(`${p.phase} ${p.done}/${p.total} ${p.current}`)
    }
    await seedPendingPlugins({
      steps: [
        { name: 'a', spec: 'a@1.0.0', seeded: false },
        { name: 'b', spec: 'b@1.0.0', seeded: false },
      ],
      run: async (specs) => (specs.length > 1 ? 1 : 0), // 批量失败 → 逐个回退
      onProgress: track,
    })
    expect(events).toEqual([
      'batch 0/2 a@1.0.0, b@1.0.0',
      'step 1/2 a@1.0.0',
      'step 2/2 b@1.0.0',
    ])
  })
})
