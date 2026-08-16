/** dsh-plugin-install host entry: mount installer HTTP routes once the
 * profile composes the webServer service. */

import type { Context } from '@deepseek-ai/cordis'
import { mountInstallerRoutes } from './routes.ts'
import { argvProfile, profileDir } from './profile.ts'
import type { InstallerHost } from './types.ts'
import type { WebServerService } from './types.ts'

export const name = 'dsh-plugin-install'

/** Optional cordis.yml configuration; profile defaults to the booted one. */
export interface Config {
  /** Profile installs target; defaults to `--profile` argv or `web`. */
  profile?: string
}

/** Structural host surface (the webServer service + dynamic plugin mounting). */
function asInstallerHost(ctx: Context & { webServer: WebServerService }): InstallerHost {
  return ctx as unknown as InstallerHost
}

export function apply(ctx: Context, config?: Config): void {
  const profile = config?.profile ?? argvProfile() ?? 'web'
  const dirPath = profileDir(profile)
  ctx.inject(['webServer'], (hostCtx: Context) => {
    const host = asInstallerHost(hostCtx as Context & { webServer: WebServerService })
    ctx.effect(() => mountInstallerRoutes(host, { profile, profileDirPath: dirPath }), 'dsh-plugin-install: http routes')
  })
}