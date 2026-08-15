/** 已装第三方插件 = dsh.profile.bundles − 模板基线（设计书 §7）。 */
export function parseInstalledPlugins(manifestJson: string, baseline: string[] = ['dsh-base', 'dsh-web-app']): string[] {
  try {
    const manifest = JSON.parse(manifestJson) as { dsh?: { profile?: { bundles?: unknown } } }
    const bundles = manifest.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) return []
    return bundles.filter((name): name is string => typeof name === 'string' && !baseline.includes(name))
  } catch {
    return []
  }
}
