import { describe, expect, it } from 'vitest'
import { resolveSigning, signedConfig } from '../../../scripts/signed-config.mjs'

const storeEnv = { DSH_CSC_SUBJECT: 'CN=Some Dev' }
const sha1Env = { DSH_CSC_SHA1: 'ABCD1234' }
const pfxEnv = { WIN_CSC_LINK: 'C:\\certs\\me.pfx', WIN_CSC_KEY_PASSWORD: 'pw' }
const azureEnv = {
  AZURE_TS_ENDPOINT: 'https://eus.codesigning.azure.net',
  AZURE_TS_ACCOUNT_NAME: 'acc',
  AZURE_TS_PROFILE_NAME: 'prof',
  AZURE_TENANT_ID: 't',
  AZURE_CLIENT_ID: 'c',
  AZURE_CLIENT_SECRET: 's',
}

describe('resolveSigning（docs/signing.md）', () => {
  it('证书库使用者/指纹任一在场 → store 模式', () => {
    expect(resolveSigning(storeEnv)).toMatchObject({ mode: 'store', missing: [], conflict: null })
    expect(resolveSigning(sha1Env)).toMatchObject({ mode: 'store', missing: [], conflict: null })
  })

  it('pfx 双变量齐全 → pfx 模式；缺密码则报缺项', () => {
    expect(resolveSigning(pfxEnv)).toMatchObject({ mode: 'pfx', missing: [], conflict: null })
    expect(resolveSigning({ WIN_CSC_LINK: 'C:\\a.pfx' }).missing).toEqual(['WIN_CSC_KEY_PASSWORD'])
  })

  it('azure 六变量齐全 → azure 模式；不全则列出缺口', () => {
    expect(resolveSigning(azureEnv)).toMatchObject({ mode: 'azure', missing: [], conflict: null })
    const partial = resolveSigning({ ...azureEnv, AZURE_TS_PROFILE_NAME: '', AZURE_CLIENT_SECRET: '' })
    expect(partial.mode).toBeNull()
    expect(partial.missing).toEqual(['AZURE_TS_PROFILE_NAME', 'AZURE_CLIENT_SECRET'])
  })

  it('多套凭据同时在场且未指定 DSH_SIGN → 报二义性', () => {
    const r = resolveSigning({ ...storeEnv, ...pfxEnv })
    expect(r.mode).toBeNull()
    expect(r.conflict).toMatch(/DSH_SIGN/)
  })

  it('DSH_SIGN 强制模式并对该模式校验缺项', () => {
    expect(resolveSigning({ DSH_SIGN: 'pfx', ...storeEnv })).toMatchObject({ mode: 'pfx', missing: ['WIN_CSC_LINK', 'WIN_CSC_KEY_PASSWORD'] })
    expect(resolveSigning({ DSH_SIGN: 'azure', ...azureEnv })).toMatchObject({ mode: 'azure', missing: [] })
  })

  it('空环境 → mode null，按缺口最小的路径给补全清单', () => {
    const r = resolveSigning({})
    expect(r.mode).toBeNull()
    expect(r.missing).toEqual(['DSH_CSC_SUBJECT 或 DSH_CSC_SHA1'])
  })
})

describe('signedConfig（electron-builder.signed.mjs 的配置生成）', () => {
  it('azure：注入 win.azureSignOptions，其余继承基础 yml', () => {
    const config = signedConfig(azureEnv) as { extends: string; win: Record<string, unknown> }
    expect(config.extends).toBe('./electron-builder.yml')
    expect(config.win.azureSignOptions).toEqual({
      endpoint: 'https://eus.codesigning.azure.net',
      codeSigningAccountName: 'acc',
      certificateProfileName: 'prof',
    })
  })

  it('store：注入 signtoolOptions 的 subject 或 sha1', () => {
    const bySubject = signedConfig(storeEnv).win.signtoolOptions
    expect(bySubject).toEqual({ certificateSubjectName: 'CN=Some Dev' })
    const bySha1 = signedConfig(sha1Env).win.signtoolOptions
    expect(bySha1).toEqual({ certificateSha1: 'ABCD1234' })
  })

  it('pfx：不加任何 win 覆盖（凭据走环境变量，基础 yml 原样生效）', () => {
    const config = signedConfig(pfxEnv)
    expect(config).toEqual({ extends: './electron-builder.yml' })
  })

  it('凭据不全时抛错并指向 docs/signing.md，挡下构建', () => {
    expect(() => signedConfig({})).toThrow(/docs\/signing\.md/)
    expect(() => signedConfig({ ...storeEnv, ...pfxEnv })).toThrow(/DSH_SIGN/)
  })
})
