export {}
declare global {
  interface Window {
    dshDesktop: {
      retry(): void
      openLogs(): void
      plugins: { list(): Promise<string[]>; run(args: string[]): Promise<number>; restartSidecar(): void }
    }
  }
}
