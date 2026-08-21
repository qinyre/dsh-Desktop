export {}
declare global {
  interface Window {
    dshDesktop: {
      retry(): void
      openLogs(): void
      onActivity(callback: (text: string) => void): void
    }
  }
}
