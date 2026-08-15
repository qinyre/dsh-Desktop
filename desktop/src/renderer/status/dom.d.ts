export {}
declare global {
  interface Window {
    dosket: {
      retry(): void
      openLogs(): void
      plugins: { list(): Promise<string[]>; run(args: string[]): Promise<number>; restartSidecar(): void }
    }
  }
}
