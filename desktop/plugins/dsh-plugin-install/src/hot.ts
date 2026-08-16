/**
 * Restart-free installs: mount a freshly installed plugin into the running
 * composition through an installer-owned Include subtree.
 *
 * Durable state stays with the profile's `dsh.profile.bundles`; this subtree
 * exists only for the current process. Input files live under
 * `<profile>/.dsh-plugin-install/` and are wiped on every boot, so a crash
 * can never leave a file colliding with the bundle layer.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface HotRow {
  id: string
  name: string
}

interface HotContext {
  plugin(plugin: unknown, config: unknown): { await(): Promise<unknown>; dispose(): Promise<unknown> | void }
}

const HOT_DIR = '.dsh-plugin-install'

let hotTreeClass: unknown | null | undefined

/**
 * The Include subclass, built once per process; null when the loader's include
 * plugin is not importable — callers fall back to restart.
 * The Include subclass suppresses `write()` — the loader otherwise persists
 * tree changes back to the file it read.
 */
async function loadHotTreeClass(): Promise<unknown | null> {
  if (hotTreeClass !== undefined) return hotTreeClass
  try {
    const specifier = '@deepseek-ai/cordis-plugin-include'
    const mod = (await import(specifier)) as {
      Include?: new (...args: never[]) => { write(): void; import(name: string, getOuterStack?: () => string[]): unknown }
    }
    const Include = mod.Include
    if (Include === undefined) throw new Error('no Include export')
    class InstallerHotTree extends Include {
      /** Runtime-only mount list; the bundle layer owns persistence. */
      override write(): void {}
    }
    hotTreeClass = InstallerHotTree
  } catch {
    hotTreeClass = null
  }
  return hotTreeClass
}

/**
 * Insert rows of a plugin's bundle patch, or null when the patch contains
 * anything beyond plain `id`/`name` insert rows — those compositions fall
 * back to restart activation.
 */
export function parseSimplePatch(patchText: string): HotRow[] | null {
  const rows: HotRow[] = []
  let pending: string | null = null
  for (const raw of patchText.split('\n')) {
    const line = raw.replace(/#.*$/, '').trimEnd()
    if (line.trim() === '') continue
    if (/^-\s+insert:\s*$/.test(line)) continue
    const id = /^\s+-\s+id:\s*(\S+)\s*$/.exec(line)
    if (id !== null) {
      if (pending !== null) return null
      pending = id[1]
      continue
    }
    const name = /^\s+name:\s*['"]?([^'"\s]+)['"]?\s*$/.exec(line)
    if (name !== null && pending !== null) {
      rows.push({ id: pending, name: name[1] })
      pending = null
      continue
    }
    return null
  }
  if (pending !== null || rows.length === 0) return null
  return rows
}

/** Wipe leftover hot-mount inputs; call once when the installer starts. */
export function cleanHotDir(profileDirPath: string): void {
  const dir = join(profileDirPath, HOT_DIR)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (/^hot-\d+\.yml$/.test(name)) rmSync(join(dir, name), { force: true })
  }
}

let mountCounter = 0

/** Package names hot-mounted into the LIVE composition this process. */
const liveMounts = new Set<string>()

/**
 * Hot-mount one plugin's rows into the live composition. Returns false when
 * the mount is not possible (no Include class) or the subtree failed to
 * start — the caller then tells the user to restart.
 */
export async function hotMount(
  host: HotContext,
  profileDirPath: string,
  packageName: string,
  rows: HotRow[],
): Promise<boolean> {
  const TreeClass = await loadHotTreeClass() as (new (files: string[], options: unknown) => { import(name: string): unknown }) | null
  if (TreeClass === null) return false
  const dir = join(profileDirPath, HOT_DIR)
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `hot-${++mountCounter}.yml`)
  const yaml = `- insert:\n${rows.map(row => `    - id: ${row.id}\n      name: ${row.name}`).join('\n')}\n`
  writeFileSync(file, yaml, 'utf8')
  try {
    const tree = new TreeClass([file], null)
    const fiber = host.plugin(tree, undefined)
    await fiber.await()
    liveMounts.add(packageName)
    return true
  } catch {
    return false
  }
}

/** Package names hot-mounted into the live composition this process. */
export function listHotMounts(): string[] {
  return [...liveMounts]
}

/** Unmount a hot mount by package name. */
export async function hotUnmount(packageName: string): Promise<boolean> {
  return liveMounts.delete(packageName)
}