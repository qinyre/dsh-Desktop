/**
 * dsh-plugin-install end-to-end smoke: real source dsh, temp DSH_HOME,
 * install this package into a profile, boot `dsh web`, then probe the
 * installer routes.
 *
 * Gate: DSH_DESKTOP_PLUGIN_SMOKE=1 (mirrors desktop's market.smoke.test.ts).
 * Requires: deepseek-harness checked out beside this repo, `pnpm install`
 * already run there, and a host that permits capturing child-process output
 * (the DSH sandbox denies spawned-pipe capture with EPERM).
 */

import { spawn, execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const here = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const repoRoot = join(here, '..', '..', '..', 'deepseek-harness')
const guard = existsSync(join(repoRoot, 'apps', 'cli', 'src', 'bin.ts'))
const [nodeMajor, nodeMinor] = process.version.slice(1).split('.').map(Number)
const nodeOk = (nodeMajor === 22 && nodeMinor >= 19) || nodeMajor >= 24

const smokeRoot = mkdtempSync(join(tmpdir(), 'dsh-plugin-install-smoke-'))
const dshBin = join(repoRoot, 'apps', 'cli', 'src', 'bin.ts')
const pluginDir = here

/** Run the source-mode dsh CLI, capturing output (test env only). */
function dsh(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, ['--import', 'tsx/esm', dshBin, ...args], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
    }, (error, stdout, stderr) => {
      const code = error === null ? 0 : (error as NodeJS.ErrnoException & { code?: unknown }).code === undefined ? 1 : 1
      resolve({ code, out: `${stdout}\n${stderr}` })
    })
  })
}

/** Boot `dsh web` on a random port; resolve once the URL line appears. */
function bootWeb(dshHome: string, profile: string): Promise<{ port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', dshBin, '--profile', profile, 'web', '--port', '0', '--host', '127.0.0.1'], {
      cwd: repoRoot,
      env: { ...process.env, DSH_HOME: dshHome, DSH_DESKTOP: '' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let buffer = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`timed out waiting for dsh web URL line; output:\n${buffer}`))
    }, 120_000)
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString()
      const match = /dsh web: http:\/\/127\.0\.0\.1:(\d+)/.exec(buffer)
      if (match !== null) {
        clearTimeout(timer)
        child.stdout?.off('data', onData)
        child.stderr?.off('data', onData)
        resolve({ port: Number(match[1]) })
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    afterAll(() => { try { child.kill() } catch { /* already gone */ } })
  })
}

describe.skipIf(process.env.DSH_DESKTOP_PLUGIN_SMOKE !== '1' || !guard || !nodeOk)('dsh-plugin-install smoke', () => {
  afterAll(() => {
    // Only ever remove the exact temp dir this test created.
    if (smokeRoot.startsWith(tmpdir()) && smokeRoot.includes('dsh-plugin-install-smoke-')) {
      rmSync(smokeRoot, { recursive: true, force: true })
    }
  })

  it('installs the package into a temp profile, boots web, and serves the installer routes', { timeout: 240_000 }, async () => {
    const env = { DSH_HOME: smokeRoot }

    // 1. `dsh plugin --profile smoke add file:<this package>`.
    const install = await dsh(['plugin', '--profile', 'smoke', 'add', `file:${pluginDir}`], env)
    expect(install.code, install.out).toBe(0)

    // 2. The reconcile wrote dsh.profile.bundles with our package.
    const manifest = JSON.parse(readFileSync(join(smokeRoot, 'profiles', 'smoke', 'package.json'), 'utf8')) as {
      dsh?: { profile?: { bundles?: string[] } }
    }
    expect(manifest.dsh?.profile?.bundles).toContain('dsh-plugin-install')

    // 3. Boot `dsh web --profile smoke --port 0` and wait for the URL line.
    const { port } = await bootWeb(smokeRoot, 'smoke')

    // 4. Probe the installer routes.
    const status = await fetch(`http://127.0.0.1:${port}/dsh-plugin-install/status`)
    expect(status.status).toBe(200)
    const body = await status.json() as { installed?: string[]; desktop?: boolean }
    expect(body.installed).toContain('dsh-plugin-install')
    expect(body.desktop).toBe(false)
  })
})