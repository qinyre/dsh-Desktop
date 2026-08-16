// 签名构建的凭据协商（配置指南：仓库根 docs/signing.md）。三条路径，二选一/三选一：
//
// store —— 2023-06 起 CA/B 规范要求 OV 证书私钥放硬件或云 HSM，新证书（如 Certum
//          SimplySign、USB 令牌）导不出 .pfx，装好厂商驱动后证书出现在 Windows
//          证书库里，signtool 按使用者/指纹直签。
//          变量：DSH_CSC_SUBJECT（CN=…，与 DSH_CSC_SHA1 二选一）→ win.signtoolOptions.certificateSubjectName。
// pfx   —— 旧式文件证书。electron-builder 原生读 WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD，无需配置。
// azure —— Azure Trusted Signing（现名 Artifact Signing；个人身份验证目前仅美/加）。
//          凭据沿用 AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET（EnvironmentCredential），
//          服务参数 → win.azureSignOptions。
//
// 多套凭据同时在场时必须用 DSH_SIGN 显式指定，避免静默签错。

export const SIGNING_ENV_VARS = {
  store: {
    DSH_CSC_SUBJECT: '证书库内证书的使用者（CN=…；装好 SimplySign/令牌驱动后可见）',
    DSH_CSC_SHA1: '证书 SHA1 指纹（与 DSH_CSC_SUBJECT 二选一）',
  },
  pfx: {
    WIN_CSC_LINK: '.pfx 证书文件路径',
    WIN_CSC_KEY_PASSWORD: '.pfx 密码',
  },
  azure: {
    AZURE_TS_ENDPOINT: '服务端点（形如 https://eus.codesigning.azure.net）',
    AZURE_TS_ACCOUNT_NAME: 'Code Signing Account 名称',
    AZURE_TS_PROFILE_NAME: 'Certificate Profile 名称',
    AZURE_TENANT_ID: 'Microsoft Entra 租户 ID',
    AZURE_CLIENT_ID: 'Microsoft Entra 应用（client）ID',
    AZURE_CLIENT_SECRET: 'Microsoft Entra 应用密码',
  },
}

/** @returns {{ mode: 'store' | 'pfx' | 'azure' | null, missing: string[], conflict: string | null }} */
export function resolveSigning(env = process.env) {
  const missingOf = {
    store: (env.DSH_CSC_SUBJECT || env.DSH_CSC_SHA1) ? [] : ['DSH_CSC_SUBJECT 或 DSH_CSC_SHA1'],
    pfx: Object.keys(SIGNING_ENV_VARS.pfx).filter((k) => !env[k]),
    azure: Object.keys(SIGNING_ENV_VARS.azure).filter((k) => !env[k]),
  }
  const forced = env.DSH_SIGN
  if (forced != null) {
    if (forced !== 'store' && forced !== 'pfx' && forced !== 'azure') {
      return { mode: null, missing: [], conflict: `DSH_SIGN 只能是 store / pfx / azure，收到 "${forced}"` }
    }
    return { mode: forced, missing: missingOf[forced], conflict: null }
  }
  const ready = ['store', 'pfx', 'azure'].filter((m) => missingOf[m].length === 0)
  if (ready.length > 1) {
    return { mode: null, missing: [], conflict: `检测到多套签名凭据（${ready.join(' + ')}）：请设置 DSH_SIGN=<mode> 指定其一` }
  }
  if (ready.length === 1) return { mode: ready[0], missing: [], conflict: null }
  // 一套都没配全：按“已配变量最多”的那套报告缺项（用户意图最明显的那条路径），照着补即可。
  const setCount = {
    store: (env.DSH_CSC_SUBJECT ? 1 : 0) + (env.DSH_CSC_SHA1 ? 1 : 0),
    pfx: Object.keys(SIGNING_ENV_VARS.pfx).filter((k) => env[k]).length,
    azure: Object.keys(SIGNING_ENV_VARS.azure).filter((k) => env[k]).length,
  }
  const partial = ['store', 'pfx', 'azure'].sort((a, b) => setCount[b] - setCount[a])[0]
  return { mode: null, missing: missingOf[partial], conflict: null }
}

/**
 * electron-builder 动态配置（--config electron-builder.signed.mjs）：
 * 基础配置继承 electron-builder.yml，按模式追加签名段；凭据未就绪则抛错挡下构建。
 */
export function signedConfig(env = process.env) {
  const { mode, missing, conflict } = resolveSigning(env)
  const problems = []
  if (conflict) problems.push(conflict)
  if (mode == null && !conflict) problems.push('未检测到任何一套完整的签名凭据')
  if (missing.length > 0) {
    problems.push(`缺少：\n${missing.map((k) => `  ${k}`).join('\n')}`)
  }
  if (problems.length > 0) {
    throw new Error(`签名构建未就绪：\n${problems.join('\n')}\n凭据配置见 docs/signing.md（仓库根目录）。`)
  }
  if (mode === 'azure') {
    return {
      extends: './electron-builder.yml',
      win: {
        azureSignOptions: {
          endpoint: env.AZURE_TS_ENDPOINT,
          codeSigningAccountName: env.AZURE_TS_ACCOUNT_NAME,
          certificateProfileName: env.AZURE_TS_PROFILE_NAME,
        },
      },
    }
  }
  if (mode === 'store') {
    const signtoolOptions = {}
    if (env.DSH_CSC_SUBJECT) signtoolOptions.certificateSubjectName = env.DSH_CSC_SUBJECT
    if (env.DSH_CSC_SHA1) signtoolOptions.certificateSha1 = env.DSH_CSC_SHA1
    return { extends: './electron-builder.yml', win: { signtoolOptions } }
  }
  // pfx：凭据全部走环境变量（WIN_CSC_LINK / WIN_CSC_KEY_PASSWORD），win 配置原样继承基础 yml。
  return { extends: './electron-builder.yml' }
}
