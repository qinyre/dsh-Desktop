/** The shared web shell's desktop bridge, when the installer runs inside
 * DSH Desktop's BrowserWindow. `restartSidecar` lets the Settings UI hand a
 * restart back to the shell (the sidecar is supervised; a raw re-exec would
 * orphan it). Absent on standalone dsh — the tab falls back to a hint. */

declare global {
  interface Window {
    /** Injected by the desktop preload; undefined on standalone dsh. */
    dshDesktop?: {
      retry(): void
      openLogs(): void
      /** New IPC: request the desktop shell to restart its sidecar. */
      restartSidecar?(): void
    }
  }
}

export {}