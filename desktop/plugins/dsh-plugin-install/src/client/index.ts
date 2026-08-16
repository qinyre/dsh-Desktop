/** dsh-plugin-install client entry: contributes the “Install” tab into the
 * Web Settings → Plugins section. The tab runs on the same web server as the
 * host routes (/dsh-plugin-install/*), so it calls them with plain fetch. */

import { createElement as h } from 'react'
import { InstallTab, type InstallOutcome, type InstallStatus } from './InstallTab.tsx'
import { zh, en } from './locales.ts'

/** Locale dictionary namespace owned by this plugin. */
export const NS = 'settings.pluginInstall'

export type { InstallTabInjected, InstallStatus, InstallOutcome } from './InstallTab.tsx'

/** The `t` function bound by the locale service. */
export interface Translate {
  (key: string): string
}

/** Minimal structural subset of the slots service. */
interface SlotsService {
  inject(slot: string, register: () => unknown): void
  register(meta: Record<string, unknown>, component: () => unknown): unknown
}

/** Minimal structural subset of the locale service. */
interface LocaleService {
  register(namespace: string, dicts: { zh: Record<string, string>; en: Record<string, string> }): unknown
  bind(namespace: string): Translate
}

/** The client cordis context this plugin relies on (structural). */
interface InstallClientContext {
  effect(callback: () => unknown, label?: string): void
  on(event: string, callback: () => void): () => void
  locale: LocaleService
  slots: SlotsService
}

/** Same-origin fetch of the installer host routes. */
async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const body = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
  return body
}

export const name = 'dsh-plugin-install'
export const inject = ['slots', 'locale']

export function apply(ctx: InstallClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-plugin-install: dictionaries')

  const t = ctx.locale.bind(NS)

  ctx.slots.inject('settings.plugins.tab', () => {
    const injected = {
      status: () => fetchJson<InstallStatus>('/dsh-plugin-install/status'),
      install: async (spec: string): Promise<InstallOutcome> =>
        fetchJson<InstallOutcome>('/dsh-plugin-install/install', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ spec }),
        }),
      uninstall: async (name: string): Promise<InstallOutcome> =>
        fetchJson<InstallOutcome>('/dsh-plugin-install/uninstall', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        }),
      cancel: async (): Promise<void> => {
        await fetchJson('/dsh-plugin-install/cancel', { method: 'POST' })
      },
      restart: (): void => {
        // Desktop: hand the restart to the shell (supervised sidecar).
        // Standalone: tell the user to restart dsh themselves.
        if (window.dshDesktop?.restartSidecar !== undefined) {
          window.dshDesktop.restartSidecar()
        } else {
          void fetch('/dsh-plugin-install/restart', { method: 'POST' }).catch(() => undefined)
        }
      },
      desktop: window.dshDesktop !== undefined,
    }

    return ctx.slots.register({
      name: 'settings.plugins.tab',
      id: 'install',
      order: 20,
      label: () => t('tab'),
      locale: NS,
      inject: () => injected,
    }, () => h(InstallTab, { t, injected }))
  })
}