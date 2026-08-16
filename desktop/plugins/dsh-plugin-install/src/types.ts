/** Shared types across the installer host modules. */

/** One `dsh plugin …` command outcome. */
export interface InstallResult {
  exitCode: number | null
  timedOut: boolean
  stdout: string
  stderr: string
  /** True when the run ended by user cancellation. */
  cancelled: boolean
}

/** Live progress snapshot, read by the status route. */
export interface InstallProgress {
  active: boolean
  target: string
  startedAt: number
  lastLine: string
  lastError: string | null
  cancelling: boolean
}

/**
 * Route validation of one install target; allowlisted characters only.
 * Deliberately excludes `>` `<` `*` (shell redirection/glob risk under the
 * win32 shell:true path) and whitespace; version ranges stay expressible
 * through `^` `~` `=` (e.g. `pkg@^1.0`, `pkg@latest`).
 */
export const SPEC_RE = /^[A-Za-z0-9@:./_#+~^=*-]+$/

/** Upper bound of a single spec, and of the whole body. */
export const MAX_SPEC_LENGTH = 200

/** The webServer service subset this plugin consumes (structural). */
export interface WebServerService {
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
  }): () => void
}

import type { IncomingMessage, ServerResponse } from 'node:http'

/** The host surface the installer needs: routes + dynamic plugin mounting. */
export interface InstallerHost {
  webServer: WebServerService
  plugin(plugin: unknown, config: unknown): { await(): Promise<unknown>; dispose(): Promise<unknown> | void }
}