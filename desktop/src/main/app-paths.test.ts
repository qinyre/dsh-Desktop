import { describe, expect, it } from 'vitest'
import { buildSidecarEnv, resolveAppPaths } from './app-paths'

describe('resolveAppPaths / buildSidecarEnv', () => {
  it('packaged: npm mode + dedicated DSH_HOME under userData', () => {
    const paths = resolveAppPaths({ packaged: true, env: {}, userDataDir: '/ud', repoRoot: '/repo' })
    expect(paths.mode).toBe('npm')
    expect(paths.dshHome).toBe('/ud/dsh-home')
    const env = buildSidecarEnv(paths, { PATH: 'x' })
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
    expect(env.DSH_HOME).toBe('/ud/dsh-home')
  })
  it('dev: source mode, DSH_HOME untouched', () => {
    const paths = resolveAppPaths({ packaged: false, env: { DESKTOP_DSH_MODE: 'source' }, userDataDir: '/ud', repoRoot: '/repo' })
    expect(paths.mode).toBe('source')
    const env = buildSidecarEnv(paths, { PATH: 'x' })
    expect(env.DSH_HOME).toBeUndefined()
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
  })
  it('shimDir is prepended to PATH for the whole sidecar tree', () => {
    const paths = resolveAppPaths({ packaged: true, env: {}, userDataDir: '/ud', repoRoot: '/repo' })
    const env = buildSidecarEnv(paths, { PATH: 'x' }, { shimDir: '/ud/bin' })
    const delim = process.platform === 'win32' ? ';' : ':'
    expect(env.PATH).toBe(`/ud/bin${delim}x`)
    const bare = buildSidecarEnv(paths, { PATH: 'x' })
    expect(bare.PATH).toBe('x')
  })
})
