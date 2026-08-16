/** Settings → Plugins “Install” tab: arbitrary-spec install + uninstall.
 * Pure presentation-layer: receives everything through injected props. */

import { useState } from 'react'
import type { CSSProperties, ReactElement } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from './index.ts'

/** Injected business face: HTTP calls to the installer host routes. */
export interface InstallTabInjected {
  status(): Promise<InstallStatus>
  install(spec: string): Promise<InstallOutcome>
  uninstall(name: string): Promise<InstallOutcome>
  cancel(): Promise<void>
  restart(): void
  desktop: boolean
}

export interface InstallStatus {
  desktop: boolean
  active: boolean
  target: string
  lastLine: string
  lastError: string | null
  cancelling: boolean
  installed: string[]
}

export interface InstallOutcome {
  ok: boolean
  hot: boolean
  cancelled?: boolean
  error?: string
  installed: string[]
}

/** One entry in the installed list. */
export interface InstalledRow {
  name: string
}

export function InstallTab(props: { t: Translate; injected: InstallTabInjected }): ReactElement {
  const { t, injected } = props
  const [spec, setSpec] = useState('')
  const [installed, setInstalled] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<InstallOutcome | null>(null)
  const [confirmName, setConfirmName] = useState<string | null>(null)

  const refresh = async (): Promise<void> => {
    const status = await injected.status()
    setInstalled(status.installed)
    setBusy(status.active)
  }

  /** Keep the list fresh when the tab mounts and after each operation. */
  void refresh()

  const doInstall = async (): Promise<void> => {
    const trimmed = spec.trim()
    if (trimmed === '' ) return
    setBusy(true)
    setOutcome(null)
    try {
      const result = await injected.install(trimmed)
      setOutcome(result)
      const status = await injected.status()
      setInstalled(status.installed)
      setBusy(status.active)
      if (result.ok) setSpec('')
    } finally {
      setBusy(false)
    }
  }

  const doUninstall = async (): Promise<void> => {
    if (confirmName === null) return
    setBusy(true)
    try {
      const result = await injected.uninstall(confirmName)
      setOutcome(result)
      const status = await injected.status()
      setInstalled(status.installed)
    } finally {
      setBusy(false)
      setConfirmName(null)
    }
  }

  const style: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 12 }

  return (
    <div style={style}>
      <h3>{t('title')}</h3>
      <p>{t('intro')}</p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Input
          placeholder={t('specPh')}
          value={spec}
          onChange={(event) => setSpec(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter') void doInstall() }}
          style={{ flex: 1 }}
        />
        <Button variant="primary" disabled={busy || spec.trim() === ''} onClick={() => void doInstall()}>
          {busy ? t('installing') : t('install')}
        </Button>
        {busy && <Button variant="ghost" onClick={() => void injected.cancel()}>{t('cancelOp')}</Button>}
      </div>

      {outcome !== null && (
        <div>
          {outcome.ok ? (
            <p>{t('success')} — {outcome.hot ? t('hotReady') : t('restartNeeded')}</p>
          ) : (
            <p>{t('failed')}{outcome.error !== undefined ? `: ${outcome.error}` : ''}</p>
          )}
          {!outcome.hot && outcome.ok && (
            <p>
              {injected.desktop
                ? t('restartDesktopHint')
                : <><span>{t('restartOtherHint')}</span>{' '}<Button variant="outline" size="sm" onClick={injected.restart}>{t('desktopRestart')}</Button></>}
            </p>
          )}
        </div>
      )}

      {busy && installed.length > 0 && (
        <p style={{ fontSize: 12 }}>{installed.join(', ')}</p>
      )}

      <h3>{t('refresh')}</h3>
      {installed.length === 0 ? <p>{t('empty')}</p> : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {installed.map((name) => (
            <li key={name} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span>{name}</span>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmName(name)}>
                {t('uninstall')}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={confirmName !== null}
        onClose={() => setConfirmName(null)}
        title={t('confirmRemove')}
        description={confirmName ?? undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmName(null)}>{t('cancel')}</Button>
            <Button variant="primary" disabled={busy} onClick={() => void doUninstall()}>{t('uninstall')}</Button>
          </>
        }
      >
        <p>{t('confirmWarn')}</p>
      </Modal>
    </div>
  )
}