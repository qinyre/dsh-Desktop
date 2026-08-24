import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * 签名哨兵：guard-diagnose / CLIENT_BOOT_SIG_RE 的日志签名逐字取自钉版运行时产物
 * （desktop 依赖的 @deepseek-ai/dsh 及其闭包——即 resolveRuntime npm 模式启动的同一
 * 棵树）。手写 fixture 测不出「harness 升版改了文案」的漂移：签名一旦失配，运行期
 * 守卫静默失明（无诊断 → 两轮空证据 → 安全模式全量停用，误伤放大器）。本测试把每条
 * 签名对应的模板原文钉在产物上，漂移在 CI 就地拦截。
 *
 * 产物里的模板是编译后的字面量（插值形如 ${stage} 保留原样）；import/apply/service/
 * services 等具体词是运行期实参，单独以调用点字面量钉住。文件名带内容哈希（SPA 资产）
 * 的按目录扫描。pnpm junction 必须经 require 链解析，不得对 node_modules 路径做
 * 字符串拼接。
 */
const here = createRequire(import.meta.url)

describe('guard signature sentinel (pinned @deepseek-ai/dsh runtime)', () => {
  const dshRequire = createRequire(here.resolve('@deepseek-ai/dsh/package.json'))
  const webAppRequire = createRequire(dshRequire.resolve('@deepseek-ai/dsh-web-app/package.json'))

  /** 包目录内的产物文件全文（pnpm junction 经 require 链解析）。 */
  function artifact(from: 'dsh' | 'web-app', pkg: string, file: string): string {
    const req = from === 'dsh' ? dshRequire : webAppRequire
    const dir = dirname(req.resolve(`${pkg}/package.json`))
    return readFileSync(join(dir, file), 'utf8')
  }

  it('host-side signatures still exist verbatim in the pinned runtime', () => {
    const loader = artifact('dsh', '@deepseek-ai/cordis-plugin-loader', 'lib/index.js')
    const boot = artifact('dsh', '@deepseek-ai/dsh-app-boot', 'lib/index.js')
    const cordis = artifact('dsh', '@deepseek-ai/cordis', 'lib/index.js')
    const include = artifact('dsh', '@deepseek-ai/cordis-plugin-include', 'lib/index.js')
    // [签名用途, 产物文本, 模板原文]
    const pins: Array<[string, string, string]> = [
      ['RE_ENTRY_FAIL 模板', loader, 'failed to ${stage} loader entry ${options.id} (${options.name}): ${detail}'],
      ['RE_ENTRY_FAIL import 阶段实参', loader, 'updateError("import"'],
      ['RE_ENTRY_FAIL apply 阶段实参', loader, 'updateError("apply"'],
      ['RE_DUP', loader, 'duplicate loader entry id: ${id}'],
      ['RE_LOAD_FAIL', boot, 'plugin(s) failed to load: ${names};'],
      ['RE_SKIP_BUNDLE', boot, 'warning: skipping profile bundle ${JSON.stringify(packageName)}'],
      ['RE_RESOLVE_BUNDLE', boot, 'cannot resolve profile bundle ${JSON.stringify(packageName)}'],
      ['RE_PARSE_FAIL 模板', boot, 'failed to parse ${label} ${file}: ${String(error)}'],
      ['RE_PARSE_FAIL patches 实参', boot, 'parsePatchList(binName, file, content, "patches")'],
      ['RE_PARSE_FAIL overlay 实参', boot, 'parsePatchList(binName, file, content, "overlay")'],
      ['RE_DID_NOT_ACTIVATE 模板', boot, '${noun} did not activate'],
      ['RE_DID_NOT_ACTIVATE 名词实参', boot, '? "entry" : "entries"'],
      ['RE_PENDING 模板', boot, 'pending (waiting for ${subject}: '],
      ['RE_PENDING 单复数实参', boot, '? "service" : "services"'],
      ['RE_SVC', cordis, 'service "${name}" has been registered at <'],
      ['patchYamlOptions !!js 方言 tag', include, 'tag:yaml.org,2002:js'],
    ]
    for (const [label, text, fragment] of pins) {
      expect(text, `钉版运行时已改写「${label}」的输出文案——guard-diagnose 签名失配，运行期诊断会静默失明，须同步正则`).toContain(fragment)
    }
  })

  it('client-side signatures still exist verbatim in the pinned client tree', () => {
    // 客户端 locale 运行时（冲突 detail「already has locale」的产出方，浏览器端加载）。
    const locale = artifact('web-app', '@deepseek-ai/dsh-client-locale', 'lib/client.js')
    expect(locale, '客户端 locale 冲突文案漂移——RE_CONFLICT_DETAIL 的冲突归类会失配').toContain('already has locale')
    // SPA 壳 bundle（CLIENT_BOOT_SIG_RE 的「web boot:」「Failed to load plugins」产出方）；
    // 资产名带内容哈希，按目录扫描任一命中即可。
    const feDir = dirname(webAppRequire.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html'))
    const assets = readdirSync(join(feDir, 'assets')).filter(f => f.endsWith('.js'))
    const joined = assets.map(f => readFileSync(join(feDir, 'assets', f), 'utf8')).join('\n')
    expect(joined, 'SPA boot 失败文案漂移——CLIENT_BOOT_SIG_RE 进不了诊断门').toContain('web boot:')
    expect(joined, 'SPA boot 失败标题漂移——（页面可见文案，连带通知链）').toContain('Failed to load plugins')
  })
})
