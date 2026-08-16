// dist:signed 第一步：在动手构建前把凭据协商清楚，缺什么直接给清单。
import { resolveSigning, SIGNING_ENV_VARS } from './signed-config.mjs'

const { mode, missing, conflict } = resolveSigning(process.env)
if (conflict || mode == null || missing.length > 0) {
  const problems = []
  if (conflict) problems.push(conflict)
  if (mode == null && !conflict) problems.push('未检测到任何一套完整的签名凭据')
  if (missing.length > 0) problems.push(`缺少：\n${missing.map((k) => `  ${k}`).join('\n')}`)
  console.error(`签名构建未就绪：\n${problems.join('\n')}\n`)

  console.error('支持三条路径（完整指南见仓库根 docs/signing.md）：\n')
  for (const [name, table] of Object.entries(SIGNING_ENV_VARS)) {
    console.error(`  DSH_SIGN=${name.padEnd(5)}`)
    for (const [key, desc] of Object.entries(table)) console.error(`    ${key.padEnd(24)} ${desc}`)
    console.error('')
  }
  process.exit(1)
}

console.log(`[signing] 凭据就绪，模式：${mode}`)
if (mode === 'pfx') console.log('[signing] pfx 模式凭据走环境变量，win 配置继承基础 electron-builder.yml')
