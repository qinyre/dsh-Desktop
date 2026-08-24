中文 · [English](README.en.md)

<div align="center">

# DSH Desktop

**[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的免配置桌面客户端**

安装后即可直接使用，无需 Node.js、pnpm 或终端。

![DSH Desktop 主窗口](docs/images/screenshot-main.png)

[![CI](https://github.com/qinyre/dsh-Desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/qinyre/dsh-Desktop/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
[![Electron](https://img.shields.io/badge/Electron-43-9feaf9?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Release](https://img.shields.io/github/v/release/qinyre/dsh-Desktop-4D6BFE)](https://github.com/qinyre/dsh-Desktop/releases)
[![dsh](https://img.shields.io/badge/bundles%20dsh-0.1.1--rc.2-4D6BFE)](https://www.npmjs.com/package/@deepseek-ai/dsh)

</div>

---

## 为什么做这个

DeepSeek Harness 自带一流的 Web UI，但它假定用户具备一套开发环境：安装 Node 与 dsh、保持终端开启并记住端口号。**DSH Desktop 把同一套 Web UI 原封不动地装进原生应用**——自带 Node 运行时和 dsh，让非开发用户也能开箱即用地运行 agent。

## 特性

- 安装包自带完整运行时（Node、pnpm shim、dsh），机器上无需预装任何环境。
- Web UI 原封不动：`dsh web` 的工作区、会话、审批、模型、技能、终端都在应用窗口里，DSH Desktop 只是外层的壳应用。
- sidecar 有监督重启（指数退避），进程崩溃后自动重新拉起；dsh 的 append-only 会话日志也保证对话不丢。
- 窗口隐藏或失焦时，等待中的审批和回合结束会发 Windows 原生通知；窗口可以关闭到托盘，长任务在后台继续。
- 首次启动预装四个插件：可视化插件市场（[dshmarket](https://github.com/dsh-market/dsh-market)）、任意包名直装的「安装」标签页（[dsh-plugin-install](https://github.com/qinyre/dsh-plugin-install)）、「技能与 MCP」管理分区（[dsh-plugin-capabilities](https://github.com/qinyre/dsh-plugin-capabilities)）、归档管理与对话刻度尺（[dsh-plugin-atlas](https://github.com/qinyre/dsh-plugin-atlas)），详见[插件](#插件)。
- 内建插件运行保障：冲突、依赖缺失、插件自身错误、配置损坏四类问题，无论出现在服务还是页面内的插件树，启动前后都会被自动识别；问题插件被隔离以保证应用照常打开，弹窗说明受影响的插件与原因。原因无法定位时由安全模式兜底，启动后仍持续监测各插件的运行状态，机制详见[插件运行保障](#插件运行保障)。
- 托盘可以直接管理插件：页面因插件故障打不开时，应用内的插件管理器随之失效，而系统托盘里的「插件管理」不依赖服务与页面——查看各插件启用状态、逐一停用或启用、手动进入安全模式、恢复被移出启动清单的插件包，全部可用。
- 原生标题栏跟随 Web UI 的明暗主题变色（Windows 11 上与页面同色，Windows 10 上跟随深浅）。
- 更新安装前会先询问，并自动备份会话、凭据和设置。

## 安装

从 [Releases](https://github.com/qinyre/dsh-Desktop/releases) 下载最新的 `DSH-Desktop-Setup-x.x.x.exe` 并运行。

环境要求：Windows 10/11 x64。安装到当前用户目录，无需管理员权限。

> 安装器未做代码签名（个人可办的证书最低约 €105/年，暂不购买），首次运行可能被 Windows SmartScreen 拦截——此时选择「更多信息」→「仍要运行」即可。如需为自己的构建签名，见 [docs/signing.md](docs/signing.md)。

### 首次运行

应用启动后会打开 dsh Web UI，引导流程与浏览器版一致：在 **Settings → Models** 里配置 API key，选择工作区目录即可。

## 插件

dsh 的三层插件能力在 DSH Desktop 里全部保留：

| 层 | 用法 |
|---|---|
| 会话内动态挂载 | 在 Web UI 里选 `cordis` agent preset——agent 运行时自行编写并挂载插件，无需重启 |
| 插件清点与配置 | Settings → Plugins，与 Web UI 相同 |
| 第三方插件包 | 设置页内的插件市场（[dshmarket](https://github.com/dsh-market/dsh-market)）或「安装」标签页（按 npm spec 直装） |

首次启动时，DSH Desktop 会将以下四个插件预装进应用自身的 profile。纯客户端插件安装后刷新页面即可生效；需要重启的变更会显示待重启提示，此时从托盘菜单或「安装」标签页选择「重启服务」。

### 插件市场 · [dshmarket](https://github.com/dsh-market/dsh-market)

跑在 Web UI 设置页里的可视化市场，收录 [awesome-dsh-plugin](https://awesome-dsh-plugin.com) 精选目录，浏览、搜索、一键安装/卸载和逐插件更新都在页面上完成，市场自身也走同一通道升级。

### 任意插件直装 · [dsh-plugin-install](https://github.com/qinyre/dsh-plugin-install)

提供一个独立于市场的「安装」标签页：输入包名（npm spec、`github:user/repo` 或本地路径）即可安装任意 dsh 插件。已安装列表同时支持逐个检查更新——npm 安装对照 registry 最新版本，github 安装对照仓库新提交——并就地升级；页面上的「重启服务」按钮交由应用壳层执行。

![「安装」标签页](docs/images/install-tab.png)

### 技能与 MCP · [dsh-plugin-capabilities](https://github.com/qinyre/dsh-plugin-capabilities)

在设置页加一个与「模型」「插件」平级的「技能与 MCP」分区：技能目录在此新建、编辑、删除，MCP 服务器（stdio 命令或 http URL）同样页面化管理；Claude Code 和 Codex 已有的技能与 MCP 配置可以直接导入，本机安装过哪些 agent，便相应提供哪些导入来源。每个技能可以单独开关是否加载，本地目录或 GitHub 仓库都能注册成额外的技能来源；分区里另有技能与 MCP 两个精选市场，一键安装、一键卸载。技能目录开箱自带 skill-creator 和 find-skills 两个只读的起步技能。

![「技能」标签页](docs/images/capabilities-skills.png)

### 归档与刻度尺 · [dsh-plugin-atlas](https://github.com/qinyre/dsh-plugin-atlas)

设置页新增一级分区「归档管理」——归档的会话在这里浏览、预览、一键恢复，自动归档规则可选配；对话区左缘同时新增刻度尺，每格对应一次发言，悬停预览、点击跳转。

![对话刻度尺](docs/images/atlas-rail.png)

![归档管理](docs/images/atlas-archive.png)

> 安装插件会在本机执行第三方代码（pnpm 生命周期脚本），这一点与 dsh CLI 相同。请只安装来源可信的插件。

## 插件运行保障

dsh 的插件以整棵树为单位激活：任何一个插件导入失败、与其他插件冲突（例如注册了相同的 entry id，或同一插件被重复组合了两份）或依赖缺失，都会导致服务整体无法启动。为此，DSH Desktop 在启动前执行一次静态检查——包括核对插件包的文件完整性，安装中断产生的残缺插件会被预先停用；若服务仍未启动成功，则依据崩溃日志定位具体插件，将其停用后自动重启。通常用户仅感知到启动稍慢，应用照常打开，随后弹窗说明被隔离的插件及其问题。

还有一类问题只发生在页面里。dsh 的界面自身也运行着一棵插件树，两个插件抢同一个资源（例如注册了相同的文案命名空间）时服务完全正常，页面却会停在插件加载失败页。守卫同样盯着这一侧：页面启动失败的报错会定位到具体插件，停用后自动刷新页面重试；重试耗尽或无法定位到插件时改为弹窗说明。会话中途出现的同类失败只报告，不会刷新正在使用的页面。

部分崩溃不留下可定位的线索，例如插件经原生代码导致进程终止，或在启动过程中无响应。连续两次此类失败后，DSH Desktop 将进入安全模式：停用全部已安装插件，仅保留系统基座，以确保客户端可以启动，并在弹窗中说明原因；若安全模式下仍无法启动，将如实提示问题可能不在插件本身。隔离记录保存在托盘菜单的「插件隔离报告」中，可随时查看；确认问题解决后可一键重新启用，若插件仍存在故障，只会被再次隔离，不会影响应用的正常使用。

以上机制都假定应用内界面最终可用，而管理插件的应用内插件页本身也是插件——故障严重到页面无法加载时，它就帮不上忙了。为此托盘菜单里有一条独立的「插件管理」通道：不依赖服务与页面，直接列出全部已安装插件及其启用状态（并注明是守卫停用、页面内停用还是手动停用），可逐一停用或启用，也可手动进入安全模式或一键全部启用。每次变更后自动重启服务使之确定生效，连续操作会合并为一次重启。被守卫移出启动清单的损坏插件包同样列在此处，确认后可重新加入并重启验证；若确实损坏，守卫会再次将其移出。

![托盘的「插件管理」子菜单](docs/images/screenshot-tray.png)

应用启动后守卫持续运行：定期检查各插件的运行状态，运行中发生故障的插件会被即时停用并记录，长期等待所需服务的插件同样留档，并体现在下一份隔离报告中。会话中途新装插件挂载失败也在这里兜住——服务不重启、故障只落在日志里，守卫巡检日志确认后同样停用，并以托盘气泡即时告知。

## 排障与反馈

多数启动故障应用会自行恢复（机制见上文[插件运行保障](#插件运行保障)）：被隔离的插件可从托盘的「插件隔离报告」一键重新启用，页面打不开时可改用托盘的「插件管理」。

仍未恢复时：从托盘图标完全退出后重新启动；查看日志 `%APPDATA%\DSH Desktop\logs\sidecar.log`——插件与启动问题都会落在这里（连同最近几轮的轮转副本）；重装应用不影响数据，见下节。

问题请通过 [GitHub Issues](https://github.com/qinyre/dsh-Desktop/issues) 反馈，附上上述日志、Windows 版本与安装包版本号。安全问题请勿开公开 issue，按 [SECURITY.md](SECURITY.md) 的渠道报告。

## 你的数据

全部用户数据集中在一个目录：`%APPDATA%\DSH Desktop\dsh-home`，包括会话记录（append-only 日志，进程崩溃也不丢已落盘的对话）、API key 与凭据、设置，以及装进应用自身 profile 的插件。复制整个目录即可完成手动备份；换机迁移时会话与凭据直接可用，个别插件可能需要重装。

- 安装更新前，应用会自动把该目录完整备份到 `%APPDATA%\DSH Desktop\backups`，保留最近一份；
- 卸载应用不会删除这些数据；确认不再需要时，删除 `%APPDATA%\DSH Desktop` 目录即可彻底清除。

## 工作原理

DSH Desktop 是一个 Electron 壳。启动时它通过 `ELECTRON_RUN_AS_NODE` 把 Electron 二进制当作 Node 运行时，拉起子进程 `dsh web --no-open --port 0 --host 127.0.0.1`，从 stdout 的就绪行解析出实际端口，再让窗口加载 `http://127.0.0.1:<端口>`。整个应用只有一个运行时，不存在 Node 版本分裂；服务也只绑定随机回环端口，不会暴露到网络。应用还会在 userData 里生成一个 pnpm shim 并前置进 sidecar 的 PATH——dsh CLI 和插件市场的安装子进程由此在未安装 Node 的机器上也能找到 pnpm。

本地 HTTP API 没有鉴权，这是上游的设计——Origin 栅栏防的是 DNS rebinding，不是本地进程。以当前用户身份运行的任何进程都能访问它，但此类进程同样能直接读取 dsh 落盘的凭据，因此实际的额外风险仅在「本机已被攻陷」这一前提下成立。栅栏的准确范围见上游 [connection 文档](https://github.com/deepseek-ai/deepseek-harness)。

## 开发

前置条件：Node.js ≥ 22.19（或 ≥ 24）、pnpm（`corepack enable` 即得，版本由 packageManager 钉住）。运行集成冒烟还需要一份上游源码的同级目录：

```bash
git clone https://github.com/qinyre/dsh-Desktop.git
cd dsh-Desktop
git clone https://github.com/deepseek-ai/deepseek-harness.git   # dev 模式 sidecar 来源
cd deepseek-harness && pnpm install && pnpm run build && cd ..
cd desktop && pnpm install
```

```bash
pnpm run dev            # 启动应用（dev 模式使用源码仓）
pnpm test               # 单元测试
pnpm run smoke:sidecar  # 真实拉起 dsh sidecar，断言就绪 + /api 可达
pnpm run smoke:guard    # 插件守卫全链路冒烟：自制 mock 插件制造冲突/缺依赖/崩溃，断言自动隔离后照常就绪
pnpm run smoke:tray     # 托盘插件管理冒烟：真 sidecar 运行态下停用/启用插件，断言 live 生效与恢复往返
DSH_DESKTOP_PLUGIN_SMOKE=1 pnpm run smoke:market   # 干净 PATH 市场预装冒烟（Windows）
pnpm run smoke:picker   # 工作区选择器 koffi 补丁冒烟（Windows）
pnpm run smoke:hideconsole  # 子进程 windowsHide 补丁冒烟（Windows）
pnpm run check:electron # 断言 Electron 内置 Node 满足 dsh 的 engines 要求
pnpm run dist           # 构建 NSIS 安装器
pnpm run verify:bundle  # 打包产物自检：依赖闭包 + 隔离路径真实启动（发布前必跑）
pnpm run dist:signed    # 构建 + 签名 + 验签（凭据环境变量见 docs/signing.md）
```

dev 模式默认从 `../deepseek-harness` 解析上游仓（可用 `DESKTOP_DSH_REPO` 覆盖）；`DESKTOP_DSH_MODE=npm` 切换到捆绑的 npm 包。冒烟在前置条件缺失时自动跳过。

### 已知补丁

`patches/` 里的五个补丁文件对应三个逻辑修复，以 pnpm patchedDependencies 声明、`pnpm install` 时自动应用；升级 dsh 使补丁失配时会在安装阶段报错，不会静默失效。完整的问题背景与取舍记录见 [docs/patches.md](docs/patches.md)。

- **启动永不砖（dsh-app-boot）**：插件包缺件（更新被中途打断的残骸）不再拒绝整树启动，改为跳过该包并告警。
- **目录选择器（koffi）**：修复打包版选择工作区文件夹后的 worker 崩溃；`pnpm run smoke:picker` 验证。
- **子进程黑窗（windowsHide / SW_HIDE）**：GUI 进程没有控制台可继承，dsh 的子进程调用与沙箱运行器原本每次都会弹出黑色控制台窗口，修复分两层；`pnpm run smoke:hideconsole` 验证。

### 目录结构

```text
desktop/
├── src/main/sidecar/     # 进程监督：状态机、运行时解析、日志
├── src/main/windows/     # 窗口控制器、导航锁、状态页
├── src/main/events/      # EventTap：两条下行 WebSocket → 通知
├── src/main/plugins/     # 插件预装 + 插件守卫（问题插件识别/隔离/报告） + 运行时 pnpm shim
├── src/main/tray/        # 托盘
├── src/main/updater/     # electron-updater + DSH_HOME 备份
└── src/renderer/         # 状态页（其余全是 dsh 的 Web UI）
```

## 路线图

- [x] 首个公开发布 + 更新源（v0.1.0 已发；启动时检查 GitHub Releases，安装前询问并备份）
- [ ] macOS 与 Linux 构建
- [ ] 路线 B：`file://` + IPC 桥接（彻底去掉本地 HTTP 面）

## 致谢

- [DeepSeek AI](https://github.com/deepseek-ai) 与 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)——DSH Desktop 只是围绕其成果的一层薄壳。
- [Electron](https://www.electronjs.org/)、[electron-vite](https://electron-vite.org/)、[electron-builder](https://www.electron.build/)、[pnpm](https://pnpm.io/)。

## 许可证

[MIT](LICENSE) © 2026 qinyre

DSH Desktop 捆绑 [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（MIT）及其依赖；DeepSeek Harness 是 DeepSeek AI 的项目，与本客户端无隶属关系。
