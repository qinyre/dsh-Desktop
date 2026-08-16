export {}
declare global {
  interface Window {
    dshDesktop: {
      retry(): void
      openLogs(): void
    }
  }
}
