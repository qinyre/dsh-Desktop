import { describe, expect, it, vi } from 'vitest'
import { auditProfileBundles, BundleBrickHealer, bundleBrickName, guttedBundlesFromManifest, repairSpecFromManifest } from './profile-heal'

// 2026-08-18 用户实机 sidecar.log 采到的报错行（路径含空格与反斜杠原样保留）。
const BRICK_LINE = 'Error: dsh: cannot resolve profile bundle "dsh-plugin-capabilities" from the dsh installation or C:\\Users\\86184\\AppData\\Roaming\\DSH Desktop\\dsh-home\\profiles\\web; run \'dsh plugin --profile web install\' if its dependency is not installed'

// 用户实机的 profile package.json 形状（精确钉版本 + bundles 对账）。
const MANIFEST = JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dshmarket', 'dsh-plugin-install', 'dsh-plugin-capabilities'] } },
  dependencies: {
    'dsh-plugin-capabilities': '0.3.5',
    'dsh-plugin-install': '0.2.0',
    dshmarket: '1.11.2',
  },
}, null, 2)

describe('bundleBrickName', () => {
  it('extracts the package from the dsh-app-boot fatal line', () => {
    expect(bundleBrickName(BRICK_LINE)).toBe('dsh-plugin-capabilities')
  })
  it('takes the last occurrence (crash loop repeats the error)', () => {
    const loop = `${BRICK_LINE.replace('dsh-plugin-capabilities', 'dshmarket')}\nNode.js v24.18.1\n${BRICK_LINE}\n`
    expect(bundleBrickName(loop)).toBe('dsh-plugin-capabilities')
  })
  it('ignores unrelated failures and GBK mojibake lines', () => {
    expect(bundleBrickName("'cmd' 不是内部或外部命令")).toBeNull()
    expect(bundleBrickName('Error: dsh: plugin tree failed to load: failed to import loader entry ui-skin-x')).toBeNull()
    expect(bundleBrickName('')).toBeNull()
  })
})

describe('repairSpecFromManifest', () => {
  it('pins to the declared dependency version (restore last known good)', () => {
    expect(repairSpecFromManifest(MANIFEST, 'dsh-plugin-capabilities')).toBe('dsh-plugin-capabilities@0.3.5')
  })
  it('falls back to a bare name when bundles declare it but the dependency line vanished', () => {
    expect(repairSpecFromManifest(MANIFEST, 'dsh-plugin-install')).toBe('dsh-plugin-install@0.2.0')
    const missing = JSON.parse(MANIFEST) as { dependencies: Record<string, string> }
    delete missing.dependencies['dsh-plugin-install']
    expect(repairSpecFromManifest(JSON.stringify(missing), 'dsh-plugin-install')).toBe('dsh-plugin-install')
  })
  it('refuses installation-level and unknown packages (other failure classes)', () => {
    expect(repairSpecFromManifest(MANIFEST, '@deepseek-ai/dsh-base')).toBeNull()
    expect(repairSpecFromManifest(MANIFEST, 'never-installed')).toBeNull()
  })
  it('returns null on a corrupt manifest', () => {
    expect(repairSpecFromManifest('{oops', 'dshmarket')).toBeNull()
  })
})

/** 已记录的日志/清单与可编程的修复桩。 */
function healerFixture(opts?: { code?: number; error?: Error }) {
  const log = vi.fn(() => BRICK_LINE)
  const manifest = vi.fn(() => MANIFEST)
  const repair = opts?.error !== undefined
    ? vi.fn(async () => { throw opts.error })
    : vi.fn(async () => opts?.code ?? 0)
  const onRepaired = vi.fn()
  const lines: string[] = []
  const healer = new BundleBrickHealer({
    readLog: log,
    readManifest: manifest,
    repair,
    log: (line) => { lines.push(line) },
    onRepaired,
  })
  return { healer, repair, onRepaired, lines, log }
}

describe('BundleBrickHealer', () => {
  it('repairs with the pinned spec and announces recovery', async () => {
    const fx = healerFixture()
    expect(fx.healer.consider()).toBe(true)
    expect(fx.repair).toHaveBeenCalledWith('dsh-plugin-capabilities', 'dsh-plugin-capabilities@0.3.5')
    // 修复 promise 已在 consider 内部被 await 前启动；等微任务队列排空。
    await Promise.resolve()
    await Promise.resolve()
    expect(fx.onRepaired).toHaveBeenCalledTimes(1)
    expect(fx.lines.some(line => line.includes('succeeded'))).toBe(true)
  })
  it('single-flight: repeated consider() during a repair is a no-op', async () => {
    let release: (() => void) | undefined
    const repair = vi.fn(async (): Promise<number> => { await new Promise<void>(resolve => { release = resolve }); return 0 })
    const healer = new BundleBrickHealer({
      readLog: () => BRICK_LINE,
      readManifest: () => MANIFEST,
      repair,
      log: () => {},
      onRepaired: () => {},
    })
    expect(healer.consider()).toBe(true)
    expect(healer.consider()).toBe(false)
    expect(repair).toHaveBeenCalledTimes(1)
    release?.()
    await Promise.resolve()
    await Promise.resolve()
  })
  it('a healed name never heals twice; the repair budget depletes across names', async () => {
    const fx = healerFixture()
    fx.healer.consider()
    await Promise.resolve()
    await Promise.resolve()
    // 同名再次断链（修复未生效或日志残留）：不再修，避免循环。
    expect(fx.healer.consider()).toBe(false)
    expect(fx.repair).toHaveBeenCalledTimes(1)
  })
  it('skips packages the profile never declared, without burning attempts', () => {
    const fx = healerFixture()
    const foreign = BRICK_LINE.replace('dsh-plugin-capabilities', '@deepseek-ai/dsh-base')
    const healer = new BundleBrickHealer({
      readLog: () => foreign,
      readManifest: () => MANIFEST,
      repair: fx.repair,
      log: (line) => { fx.lines.push(line) },
      onRepaired: fx.onRepaired,
    })
    expect(healer.consider()).toBe(false)
    expect(fx.repair).not.toHaveBeenCalled()
    expect(fx.lines.some(line => line.includes('not declared'))).toBe(true)
  })
  it('a failed repair releases the flight but does not announce recovery', async () => {
    const fx = healerFixture({ code: 1 })
    fx.healer.consider()
    await Promise.resolve()
    await Promise.resolve()
    expect(fx.onRepaired).not.toHaveBeenCalled()
    expect(fx.lines.some(line => line.includes('failed (exit 1)'))).toBe(true)
    // 预算已消耗一次（同名不可重试，新名字仍可修，上限内）。
    expect(fx.healer.consider()).toBe(false)
  })
  it('caps total repairs per process', async () => {
    const names = ['pkg-a', 'pkg-b', 'pkg-c', 'pkg-d']
    let index = 0
    const repair = vi.fn(async () => 0)
    const healer = new BundleBrickHealer({
      readLog: () => BRICK_LINE.replace('dsh-plugin-capabilities', names[index] ?? 'pkg-x'),
      readManifest: () => JSON.stringify({ dependencies: Object.fromEntries(names.map(name => [name, '1.0.0'])) }),
      repair,
      log: () => {},
      onRepaired: () => {},
      maxRepairs: 2,
    })
    expect(healer.consider()).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    index += 1
    expect(healer.consider()).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    index += 1
    expect(healer.consider()).toBe(false)
    expect(repair).toHaveBeenCalledTimes(2)
  })
  it('tolerates unreadable log and manifest', async () => {
    const repair = vi.fn(async () => 0)
    const make = (readLog: () => string | null, readManifest: () => string | null) =>
      new BundleBrickHealer({ readLog, readManifest, repair, log: () => {}, onRepaired: () => {} })
    expect(make(() => null, () => MANIFEST).consider()).toBe(false)
    expect(make(() => BRICK_LINE, () => null).consider()).toBe(false)
    expect(repair).not.toHaveBeenCalled()
  })
  it('declines loudly (exactly once) when the log read itself throws', () => {
    const lines: string[] = []
    const healer = new BundleBrickHealer({
      readLog: () => { throw new Error('EBUSY') },
      readManifest: () => MANIFEST,
      repair: vi.fn(async () => 0),
      log: (line) => { lines.push(line) },
      onRepaired: () => {},
    })
    expect(healer.consider()).toBe(false)
    expect(healer.consider()).toBe(false)
    expect(lines.filter(line => line.includes('unreadable'))).toHaveLength(1)
  })
  it('logging failures never break the heal or strand the flight', async () => {
    const repair = vi.fn(async () => 0)
    let brick = BRICK_LINE
    const healer = new BundleBrickHealer({
      readLog: () => brick,
      readManifest: () => JSON.stringify({ dependencies: { 'dsh-plugin-capabilities': '0.3.5', 'pkg-next': '1.0.0' } }),
      repair,
      log: () => { throw new Error('appendFileSync EBUSY') },
      onRepaired: () => {},
    })
    expect(healer.consider()).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(repair).toHaveBeenCalledTimes(1)
    // 单飞已复位：新包名的断链仍能进入修复（日志持续抛错也不影响）。
    brick = BRICK_LINE.replace('dsh-plugin-capabilities', 'pkg-next')
    expect(healer.consider()).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(repair).toHaveBeenCalledTimes(2)
  })
  it('a synchronously throwing repair resets the flight and retries at terminal', () => {
    const repair = vi.fn(() => { throw new Error('spawn ENOENT') })
    const healer = new BundleBrickHealer({
      readLog: () => BRICK_LINE,
      readManifest: () => MANIFEST,
      repair,
      log: () => {},
      onRepaired: () => {},
    })
    expect(healer.consider()).toBe(true)
    expect(healer.consider()).toBe(false)
    // failed 终态（管理器放弃重启）对修复失败过的包再给一次机会。
    expect(healer.consider({ terminal: true })).toBe(true)
    expect(repair).toHaveBeenCalledTimes(2)
  })
  it('re-attempts a failed async repair once the sidecar gives up', async () => {
    const codes = [1, 0]
    const repair = vi.fn(async () => codes.shift() ?? 0)
    const healer = new BundleBrickHealer({
      readLog: () => BRICK_LINE,
      readManifest: () => MANIFEST,
      repair,
      log: () => {},
      onRepaired: () => {},
    })
    expect(healer.consider()).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(healer.consider()).toBe(false)
    expect(healer.consider({ terminal: true })).toBe(true)
    await Promise.resolve()
    await Promise.resolve()
    expect(repair).toHaveBeenCalledTimes(2)
  })
})

describe('guttedBundlesFromManifest', () => {
  it('lists dependency-managed bundles with name@spec (template bundles excluded)', () => {
    const list = guttedBundlesFromManifest(MANIFEST)!.map(({ name, spec }) => `${name}:${spec}`)
    expect(list).toEqual([
      'dshmarket:dshmarket@1.11.2',
      'dsh-plugin-install:dsh-plugin-install@0.2.0',
      'dsh-plugin-capabilities:dsh-plugin-capabilities@0.3.5',
    ])
  })
  it('passes schemed dependency specs through raw (name@ would alias-install)', () => {
    const manifest = JSON.stringify({
      dependencies: { 'dsh-plugin-x': 'github:qinyre/dsh-plugin-x#abc', 'dsh-plugin-y': 'file:../y' },
      dsh: { profile: { bundles: ['dsh-plugin-x', 'dsh-plugin-y'] } },
    })
    const list = guttedBundlesFromManifest(manifest)!
    expect(list.find(({ name }) => name === 'dsh-plugin-x')?.spec).toBe('github:qinyre/dsh-plugin-x#abc')
    expect(list.find(({ name }) => name === 'dsh-plugin-y')?.spec).toBe('file:../y')
  })
  it('returns null on a corrupt or bundle-less manifest', () => {
    expect(guttedBundlesFromManifest('{oops')).toBeNull()
    expect(guttedBundlesFromManifest('{"dependencies":{"a":"1.0.0"}}')).toBeNull()
  })
})

describe('auditProfileBundles', () => {
  it('repairs only gutted dependency bundles, sequentially with their dep spec', async () => {
    const repair = vi.fn(async () => 0)
    const lines: string[] = []
    const repaired = await auditProfileBundles({
      readManifest: () => MANIFEST,
      bundleIntact: (name) => name !== 'dsh-plugin-capabilities',
      repair,
      log: (line) => { lines.push(line) },
    })
    expect(repaired).toEqual(['dsh-plugin-capabilities'])
    expect(repair).toHaveBeenCalledTimes(1)
    expect(repair).toHaveBeenCalledWith('dsh-plugin-capabilities', 'dsh-plugin-capabilities@0.3.5')
    expect(lines.join('\n')).toContain('repairing with dsh-plugin-capabilities@0.3.5')
  })
  it('touches nothing when every bundle dir is intact', async () => {
    const repair = vi.fn(async () => 0)
    const repaired = await auditProfileBundles({
      readManifest: () => MANIFEST, bundleIntact: () => true, repair, log: () => {},
    })
    expect(repaired).toEqual([])
    expect(repair).not.toHaveBeenCalled()
  })
  it('keeps auditing past a failed or throwing repair (loader patch skips the bundle)', async () => {
    const repair = vi.fn()
      .mockImplementationOnce(async () => { throw new Error('EPERM') })
      .mockImplementationOnce(async () => 0)
    const lines: string[] = []
    const repaired = await auditProfileBundles({
      readManifest: () => MANIFEST,
      bundleIntact: (name) => name !== 'dsh-plugin-capabilities' && name !== 'dshmarket',
      repair,
      log: (line) => { lines.push(line) },
    })
    expect(repaired).toEqual(['dsh-plugin-capabilities'])
    expect(repair).toHaveBeenCalledTimes(2)
    expect(lines.join('\n')).toContain('threw: Error: EPERM')
  })
  it('skips quietly when the manifest is unreadable', async () => {
    const repair = vi.fn(async () => 0)
    const lines: string[] = []
    const repaired = await auditProfileBundles({
      readManifest: () => null, bundleIntact: () => false, repair,
      log: (line) => { lines.push(line) },
    })
    expect(repaired).toEqual([])
    expect(repair).not.toHaveBeenCalled()
    expect(lines.join('\n')).toContain('unreadable')
  })
})
