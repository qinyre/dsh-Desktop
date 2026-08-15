/**
 * 已装第三方插件 = dsh.profile.bundles − 模板基线（设计书 §7）。
 * 基线取上游 web profile 模板的实际 bundles（PROFILE_TEMPLATES.web，scoped 包名）。
 */
export const WEB_PROFILE_BASELINE: readonly string[] = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']

export function parseInstalledPlugins(manifestJson: string, baseline: readonly string[] = WEB_PROFILE_BASELINE): string[] {
  try {
    const manifest = JSON.parse(manifestJson) as { dsh?: { profile?: { bundles?: unknown } } }
    const bundles = manifest.dsh?.profile?.bundles
    if (!Array.isArray(bundles)) return []
    return bundles.filter((name): name is string => typeof name === 'string' && !baseline.includes(name))
  } catch {
    return []
  }
}
