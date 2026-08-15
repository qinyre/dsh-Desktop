import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    build: {
      rollupOptions: {
        input: {
          status: resolve('src/renderer/status/index.html'),
          plugins: resolve('src/renderer/plugins/index.html'),
        },
      },
    },
  },
})
