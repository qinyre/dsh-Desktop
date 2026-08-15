export {}
declare global {
  interface Window {
    dosket: { retry(): void; openLogs(): void }
  }
}
