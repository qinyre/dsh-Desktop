// electron-builder 动态签名配置：`npm run dist:signed` 经 --config 指定本文件。
// 基础配置继承 electron-builder.yml，按环境变量追加签名段（逻辑在 scripts/signed-config.mjs）；
// 凭据不全时抛错，构建立刻失败而不是静默产出未签名安装器。
import { signedConfig } from './scripts/signed-config.mjs'

export default function () {
  return signedConfig(process.env)
}
