/**
 * Plugin command execution: route to the desktop bridge when running inside
 * DSH Desktop, otherwise re-invoke the dsh CLI so pnpm resolution stays the
 * CLI's own (its `plugin` forwarder spawns pnpm with shell:true on win32).
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { InstallProgress, InstallResult, SPEC_RE, MAX_SPEC_LENGTH } from './types.ts'

/** True when this host runs inside DSH Desktop's sidecar (the client env). */
export function inDesktop(): boolean {
  return process.env.DSH_DESKTOP === '1'
}

/**
 * The dsh binary invocation that launched this host, so plugin commands work
 * whether dsh runs from a global bin, a local install, or repo source.
 */
export function dshArgv(): { file: string; args: string[]; cwd: string | undefined; viaShell: boolean } {
  const entry = process.argv[1]
  if (entry !== undefined && /[\\/](?:bin\.(?:js|ts)|dsh)$/.test(entry)) {
    const abs = resolve(entry)
    return { file: process.execPath, args: [...process.execArgv, abs], cwd: dirname(abs), viaShell: false }
  }
  // Bare `dsh` is a .cmd shim on Windows; only a shell can start it.
  return { file: 'dsh', args: [], cwd: undefined, viaShell: process.platform === 'win32' }
}

/** Validate one install/uninstall target against the spec allowlist. */
export function validateSpec(spec: string): string | null {
  if (spec.length === 0 || spec.length > MAX_SPEC_LENGTH) return 'spec is empty or too long'
  if (spec.startsWith('-')) return 'spec must not start with "-" (argument injection)'
  if (!SPEC_RE.test(spec)) return `spec contains unsafe characters: ${JSON.stringify(spec)}`
  return null
}

/** Progress singleton; the status route reads it, runPlugin writes it. */
export const progress: InstallProgress = {
  active: false,
  target: '',
  startedAt: 0,
  lastLine: '',
  lastError: null,
  cancelling: false,
}

/** Kill a child and its whole tree: taskkill on Windows, SIGTERM→SIGKILL on POSIX. */
function killTree(child: ChildProcess): void {
  if (process.platform === 'win32' && child.pid !== undefined) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
      return
    } catch { /* fall through */ }
  }
  const signalTree = (signal: NodeJS.Signals): void => {
    if (child.pid === undefined) return
    try { process.kill(-child.pid, signal) } catch {
      try { child.kill(signal) } catch { /* already gone */ }
    }
  }
  signalTree('SIGTERM')
  const escalate = setTimeout(() => signalTree('SIGKILL'), 5000)
  escalate.unref?.()
}

/** Cancel the plugin command currently running, if any. */
export function cancelActive(): boolean {
  if (activeChild === null) return false
  cancelRequested = true
  progress.cancelling = true
  killTree(activeChild)
  return true
}

/** The child of the operation currently running, for cancellation. */
let activeChild: ChildProcess | null = null
let cancelRequested = false

const INSTALL_TIMEOUT_MS = Number(process.env.DSH_INSTALL_TIMEOUT_MS) || 15 * 60 * 1000

/**
 * Run one `dsh plugin --profile <profile> <args…>` command with a timeout and
 * live progress. Inside DSH Desktop the command is executed through the
 * desktop bridge (the sidecar's own Node, no system Node/pnpm required);
 * outside, the CLI is re-invoked exactly as it booted this host.
 */
export function runPlugin(profile: string, pluginArgs: string[], opts: { env?: NodeJS.ProcessEnv } = {}): Promise<InstallResult> {
  const target = pluginArgs[pluginArgs.length - 1] ?? ''
  const validation = validateSpec(target)
  if (validation !== null) {
    return Promise.resolve({ exitCode: 1, timedOut: false, stdout: '', stderr: validation, cancelled: false })
  }
  progress.active = true
  progress.target = target
  progress.startedAt = Date.now()
  progress.lastLine = ''
  progress.lastError = null
  progress.cancelling = false

  const { file, args, cwd, viaShell } = dshArgv()
  const child = spawn(file, [...args, 'plugin', '--profile', profile, ...pluginArgs], {
    cwd: cwd ?? process.cwd(),
    env: opts.env ?? process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: viaShell,
  })
  activeChild = child
  cancelRequested = false
  let stdout = ''
  let stderr = ''
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    killTree(child)
  }, INSTALL_TIMEOUT_MS)

  return new Promise<InstallResult>((resolvePromise) => {
    // Line-buffered progress: keep lastLine human, cap stdout/stderr tails.
    const feed = (text: string): void => {
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (trimmed !== '') progress.lastLine = trimmed.slice(0, 200)
      }
    }
    for (const stream of [child.stdout, child.stderr]) {
      if (stream === null) continue
      stream.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        if (stream === child.stdout) stdout = (stdout + text).slice(-256 * 1024)
        else stderr = (stderr + text).slice(-64 * 1024)
        feed(text)
      })
    }
    // close (not exit): wait for stdio to drain so lastLine flushes fully.
    child.once('close', (code) => {
      clearTimeout(timer)
      progress.active = false
      progress.cancelling = false
      if (activeChild === child) activeChild = null
      if ((code !== 0 || timedOut) && stderr !== '') progress.lastError = stderr.slice(-500)
      resolvePromise({ exitCode: code, timedOut, stdout, stderr, cancelled: cancelRequested })
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      progress.active = false
      progress.cancelling = false
      if (activeChild === child) activeChild = null
      progress.lastError = error.message
      resolvePromise({ exitCode: 127, timedOut: false, stdout, stderr: `${stderr}\n${error.message}`, cancelled: false })
    })
  })
}