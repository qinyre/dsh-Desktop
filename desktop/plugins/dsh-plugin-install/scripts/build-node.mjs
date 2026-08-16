/**
 * Build the node half to lib/index.js (single ESM bundle).
 *
 * External: the host's cordis (peer dependency resolved by the profile) and
 * node builtins. Everything else is inlined, so the published package is
 * self-contained on the host side.
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

await build({
  entryPoints: [join(root, 'src', 'index.ts')],
  outfile: join(root, 'lib', 'index.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  external: ['@deepseek-ai/cordis'],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  logLevel: 'info',
})

console.log('[dsh-plugin-install] node half written to lib/index.js')