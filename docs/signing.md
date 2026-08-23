# 签名构建

未签名的安装器在下载运行时会触发 SmartScreen 警告（"Windows 已保护你的电脑"），这是社区分发最现实的信任门槛。本页记录可行的签名渠道、各自的环境变量，以及 `npm run dist:signed` 的构建入口。**官方 release 暂不签名**（个人可办的证书最低约 €105/年，暂不购买），安装说明里已写明 SmartScreen 绕过方式；本页供想自行签名的维护者或分支使用，哪天改变主意，构建链路是现成的。

## 渠道现状（2026-08 调研）

| 渠道 | 价格 | 个人可办 | SmartScreen | 备注 |
| --- | --- | --- | --- | --- |
| 不签名 | 免费 | — | 红色警告 | 当前 release 的状态 |
| Certum 开源证书（OV） | 约 €105/年 | ✓（全球） | 信誉靠下载量逐步积累 | 要求签名的软件开源（本仓库 MIT 满足） |
| Azure Trusted Signing（现名 Artifact Signing） | $9.99/月（5000 次） | 仅美/加个人 | 即时 | 大陆个人开发者暂不可用（见下） |
| EV 证书 | $300+/年 | ✗（需组织） | 即时 | 硬件令牌 |

几点背景：

- **大陆个人开发者的现实主路径是 Certum 开源证书**。购买后走身份验证（护照等），证书落在 SimplySign 云端或实体卡上。
- **Azure Trusted Signing 的个人身份验证目前只支持美国和加拿大**——法国、日本开发者都在官方问答里反馈国籍下拉里选不到自己的国家（[GitHub issue](https://github.com/Azure/artifact-signing-action/issues/81)、[Q&A](https://learn.microsoft.com/en-us/azure/artifact-signing/faq)）。组织路径则要求有三年以上可验证纳税记录的法人实体。关注 [FAQ](https://learn.microsoft.com/en-us/azure/artifact-signing/faq) 等支持范围扩大。
- 2023-06 起 CA/B 规范要求 OV 证书私钥必须放在硬件令牌或云 HSM 里，**新证书导不出 `.pfx` 文件**。所以 2024 年之后办的证书走证书库签名（store 模式），只有老证书才有 pfx 文件。
- 2026-02-27 起 CA/B 又把单张证书的有效期压到最长 459 天，到期的重签发是免费的（[Certum 公告](https://shop.certum.eu/code-signing.html)）——一年一到两年要重办一次，属于正常流程。

## 三条构建路径

`desktop/scripts/signed-config.mjs` 按环境变量自动协商模式，三选一：

| 模式 | 环境变量 | 映射到 |
| --- | --- | --- |
| `store` | `DSH_CSC_SUBJECT`（证书使用者，如 `CN=张三`）或 `DSH_CSC_SHA1`（指纹，二选一） | `win.signtoolOptions.certificateSubjectName` / `certificateSha1` |
| `pfx` | `WIN_CSC_LINK`（.pfx 路径）+ `WIN_CSC_KEY_PASSWORD` | electron-builder 内建的环境变量签名 |
| `azure` | `AZURE_TS_ENDPOINT`、`AZURE_TS_ACCOUNT_NAME`、`AZURE_TS_PROFILE_NAME` + `AZURE_TENANT_ID`、`AZURE_CLIENT_ID`、`AZURE_CLIENT_SECRET` | `win.azureSignOptions`（凭据三元组是 Entra 的 EnvironmentCredential 约定） |

**store 是新办证书的标准姿势**：装好 SimplySign Desktop（或 USB 读卡器驱动）后证书会出现在 Windows 证书库里，signtool 按使用者或指纹直签，私钥始终留在硬件/云端。

多套凭据同时在场时（比如证书库和旧 pfx 都在），用 `DSH_SIGN=store|pfx|azure` 显式指定，否则构建会拒绝开始。

## 用法

以 Certum 证书库为例（PowerShell）：

```powershell
cd desktop
$env:DSH_CSC_SUBJECT = "CN=你的名字"     # 证书库里的使用者；或用 $env:DSH_CSC_SHA1 = "指纹"
npm run dist:signed
```

`dist:signed` 一共四步，任何一步失败都会停下：

1. `check-signing-env` —— 协商凭据，缺什么直接打印清单；
2. `electron-vite build` —— 与 `npm run dist` 完全一致；
3. `electron-builder --config electron-builder.signed.mjs` —— 基础配置继承 `electron-builder.yml`，只追加签名段；凭据不全时配置加载阶段就抛错，不会开始打包；
4. `verify-signature` —— 用 `Get-AuthenticodeSignature` 校验产出的安装器，状态不是 `Valid`（包括未签名、时间戳缺失、根不受信）一律失败，防止"静默未签名"的产物流出去。

两条路径默认都带 RFC3161 时间戳（pfx 走 DigiCert，azure 走 Microsoft ACS），证书过期后已分发的安装器仍然有效。

手动验签：

```powershell
Get-AuthenticodeSignature "release\DSH-Desktop-Setup-0.1.0.exe" | Format-List Status, SignerCertificate
```

## CI

GitHub Actions 暂未配置签名凭据（公开仓库，凭据只能走 repo secrets）。需要时把对应模式的环境变量加为 secrets，在 workflow 里用同样的 `npm run dist:signed` 即可。

## 参考

- [Certum 代码签名商店](https://shop.certum.eu/code-signing.html)（含 459 天有效期公告）
- [Certum 开源证书办理实录](https://blog.assarbad.net/20221110/certum-open-source-code-signing-certificate/)（第三方，流程细节）
- [Azure Artifact Signing 快速入门](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart)
- [electron-builder Windows 签名文档](https://www.electron.build/code-signing)
