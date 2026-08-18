中文 · [English](README.en.md)

<div align="center">

# DSH Desktop

**[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的免配置桌面客户端**

安装后双击即用，不需要 Node.js、pnpm 或终端。

![DSH Desktop 主窗口](docs/images/screenshot-main.png)

[![CI](https://github.com/qinyre/dsh-Desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/qinyre/dsh-Desktop/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
[![Electron](https://img.shields.io/badge/Electron-43-9feaf9?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![dsh](https://img.shields.io/badge/bundles%20dsh-0.1.0--rc.7-4D6BFE)](https://www.npmjs.com/package/@deepseek-ai/dsh)

</div>

---

## 为什么做这个

DeepSeek Harness 自带一流的 Web UI，但它默认你有一台开发者环境：装 Node、装 dsh、开着一个终端、记住端口号。**DSH Desktop 把同一套 Web UI 原封不动地装进原生应用**——自带 Node 运行时和 dsh，让不写代码的人也能双击即用地跑起 agent。

## 特性

- 安装包自带完整运行时（Node、pnpm shim、dsh），机器上什么都不用预装。
- Web UI 原封不动：`dsh web` 的工作区、会话、审批、模型、技能、终端都在应用窗口里，DSH Desktop 只是外面那层壳。
- sidecar 有监督重启（指数退避），进程崩了会自动拉起；dsh 的 append-only 会话日志也保证对话不丢。
- 窗口隐藏或失焦时，等待中的审批和回合结束会发 Windows 原生通知；窗口可以关闭到托盘，长任务在后台继续。
- 首次启动预装四个插件：可视化插件市场（[dshmarket](https://github.com/dsh-market/dsh-market)）、任意包名直装的「安装」标签页（[dsh-plugin-install](https://github.com/qinyre/dsh-plugin-install)）、「技能与 MCP」管理分区（[dsh-plugin-capabilities](https://github.com/qinyre/dsh-plugin-capabilities)）、归档管理与对话刻度尺（[dsh-plugin-atlas](https://github.com/qinyre/dsh-plugin-atlas)），详见[插件](#插件)。
- 原生标题栏跟随 Web UI 的明暗主题变色（Windows 11 上与页面同色，Windows 10 上跟随深浅）。
- 更新安装前会先询问，并自动备份会话、凭据和设置。

## 安装

从 [Releases](https://github.com/qinyre/dsh-Desktop/releases) 下载最新的 `DSH-Desktop-Setup-x.x.x.exe` 并运行。

环境要求：Windows 10/11 x64。

> 安装器未做代码签名（个人可办的证书最低约 €105/年，暂不购买），首次运行可能被 Windows SmartScreen 拦下——点「更多信息」→「仍要运行」即可。想给自己的构建签名见 [docs/signing.md](docs/signing.md)。

### 首次运行

应用启动后会打开 dsh Web UI，引导流程与浏览器版一致：在 **Settings → Models** 里配置 API key，选择工作区目录即可。

## 插件

dsh 的三层插件能力在 DSH Desktop 里全部保留：

| 层 | 用法 |
|---|---|
| 会话内动态挂载 | 在 Web UI 里选 `cordis` agent preset——agent 运行时自己写插件并挂载，无需重启 |
| 插件清点与配置 | Settings → Plugins，与 Web UI 相同 |
| 第三方插件包 | 设置页内的插件市场（[dshmarket](https://github.com/dsh-market/dsh-market)）或「安装」标签页（按 npm spec 直装） |

首次启动时，DSH Desktop 会把下面四个插件预装进应用自己的 profile。纯客户端插件安装后刷新页面即可生效；需要重启的变更会显示待重启提示，此时从托盘菜单或「安装」标签页选「重启服务」。

### 插件市场 · [dshmarket](https://github.com/dsh-market/dsh-market)

跑在 Web UI 设置页里的可视化市场，收录 [awesome-dsh-plugin](https://awesome-dsh-plugin.com) 精选目录，浏览、搜索、一键安装/卸载和逐插件更新都在页面上完成，市场自身也走同一通道升级。

### 任意插件直装 · [dsh-plugin-install](https://github.com/qinyre/dsh-plugin-install)

贡献一个「安装」标签页，不走市场：输入包名（npm spec、`github:user/repo` 或本地路径）就能装任意 dsh 插件。已装列表还能逐个检查更新——npm 安装的对照 registry 最新版，github 安装的对照仓库新提交——就地升级；页面上的「重启服务」按钮直接交由应用壳层执行。

### 技能与 MCP · [dsh-plugin-capabilities](https://github.com/qinyre/dsh-plugin-capabilities)

在设置页加一个与「模型」「插件」平级的「技能与 MCP」分区：技能目录在此新建、编辑、删除，MCP 服务器（stdio 命令或 http URL）同样页面化管理；Claude Code 和 Codex 已有的技能与 MCP 配置可以直接导入，机器上装过哪个 agent 就多出哪份来源。每个技能可以单独开关是否加载，本地目录或 GitHub 仓库都能注册成额外的技能来源；分区里另有技能与 MCP 两个精选市场，一键安装、一键卸载。技能目录开箱自带 skill-creator 和 find-skills 两个只读的起步技能。

### 归档与刻度尺 · [dsh-plugin-atlas](https://github.com/qinyre/dsh-plugin-atlas)

在侧边栏底部加「已归档会话」面板——归档的会话在这里浏览、预览、一键恢复，自动归档规则可选配；对话区左缘同时多了一把刻度尺，每格对应一次发言，悬停预览、点击跳转。

> 安装插件会在本机执行第三方代码（pnpm 生命周期脚本），这一点与 dsh CLI 相同。请只安装来源可信的插件。

## 工作原理

DSH Desktop 是一个 Electron 壳。启动时它通过 `ELECTRON_RUN_AS_NODE` 把 Electron 二进制当作 Node 运行时，拉起子进程 `dsh web --port 0 --host 127.0.0.1`，从 stdout 的就绪行解析出实际端口，再让窗口加载 `http://127.0.0.1:<端口>`。整个应用只有一个运行时，不存在 Node 版本分裂；服务也只绑定随机回环端口，不会暴露到网络。应用还会在 userData 里生成一个 pnpm shim 并前置进 sidecar 的 PATH——dsh CLI 和插件市场的安装子进程由此在没有任何 Node 的机器上找到 pnpm。

本地 HTTP API 没有鉴权，这是上游的设计——Origin 栅栏防的是 DNS rebinding，不是本地进程。任何以你的用户身份运行的进程都能访问它，但这类进程同样能直接读取 dsh 落盘的凭据，所以实际的额外风险只在"本机已被攻陷"这一前提下成立。栅栏的准确范围见上游 [connection 文档](https://github.com/deepseek-ai/deepseek-harness)。

## 开发

前置条件：Node.js ≥ 22.19（或 ≥ 24）、npm。跑集成冒烟还需要一份上游源码的兄弟目录：

```bash
git clone https://github.com/qinyre/dsh-Desktop.git
cd dsh-Desktop
git clone https://github.com/deepseek-ai/deepseek-harness.git   # dev 模式 sidecar 来源
cd deepseek-harness && pnpm install && pnpm run build && cd ..
cd desktop && npm install
```

```bash
npm run dev            # 启动应用（dev 模式使用源码仓）
npm test               # 单元测试
npm run smoke:sidecar  # 真实拉起 dsh sidecar，断言就绪 + /api 可达
DSH_DESKTOP_PLUGIN_SMOKE=1 npm run smoke:market   # 干净 PATH 市场预装冒烟（Windows）
npm run smoke:picker   # 工作区选择器 koffi 补丁冒烟（Windows）
npm run smoke:hideconsole  # 子进程 windowsHide 补丁冒烟（Windows）
npm run check:electron # 断言 Electron 内置 Node 满足 dsh 的 engines 要求
npm run dist           # 构建 NSIS 安装器
npm run verify:bundle  # 打包产物自检：依赖闭包 + 隔离路径真实启动（发布前必跑）
npm run dist:signed    # 构建 + 签名 + 验签（凭据环境变量见 docs/signing.md）
```

dev 模式默认从 `../deepseek-harness` 解析上游仓（可用 `DESKTOP_DSH_REPO` 覆盖）；`DESKTOP_DSH_MODE=npm` 切换到捆绑的 npm 包。冒烟在前置条件缺失时自动跳过。

### 已知补丁

`patches/` 里有两个 patch-package 补丁，都由 postinstall 在 `npm ci` 之后自动应用；升级 dsh 使补丁失配时会在安装阶段报错，不会静默失效。

**目录选择器（koffi）**：dsh 的 Win32 目录选择 worker 原先用 `koffi.view()` 读取所选路径，该调用在 Electron 内嵌 Node 下会触发致命错误（`Error::New napi_get_last_error_info`，普通 Node 不受影响），打包版选择工作区文件夹后会报 "win32 folder dialog worker exited before reporting a result"。补丁将读取改为逐单元的 `koffi.decode()`；`npm run smoke:picker` 会在真实 `ELECTRON_RUN_AS_NODE` 子进程中验证。

**子进程黑窗（windowsHide / SW_HIDE）**：修复分两层。其一，dsh 的子进程执行——agent 工具的 spawn、进程树终止的 taskkill、插件安装的 pnpm 调用——都没设 `windowsHide: true`；在终端里跑 dsh 时子进程继承当前控制台无感，但 DSH Desktop 是 GUI 进程没有控制台可继承，每次调用都会弹黑色终端，补丁为三处补上。其二，Windows 沙箱运行器（受限令牌）用原生 `CreateProcessAsUserW` 拉起真正的命令，自动创建的控制台窗口不受 node 选项控制——补丁在 STARTUPINFO 里加 `STARTF_USESHOWWINDOW|SW_HIDE` 藏掉窗口。不用 CREATE_NO_WINDOW/DETACHED_PROCESS 的原因：实测二者会让 PowerShell（5.1 与 7 均是）在无控制台环境下吞掉管道输出（cmd 不受影响）。`npm run smoke:hideconsole` 覆盖两层：断言补丁在位，并在真实 `ELECTRON_RUN_AS_NODE` 子进程里经 dsh 公开的 subprocess API 与真实 ACL 运行器跑 powershell，验证输出收集与终止路径。

### 目录结构

```text
desktop/
├── src/main/sidecar/     # 进程监督：状态机、运行时解析、日志
├── src/main/windows/     # 窗口控制器、导航锁、状态页
├── src/main/events/      # EventTap：两条下行 WebSocket → 通知
├── src/main/plugins/     # 插件预装（市场、安装、能力管理、归档刻度尺） + 运行时 pnpm shim
├── src/main/tray/        # 托盘
├── src/main/updater/     # electron-updater + DSH_HOME 备份
└── src/renderer/         # 状态页（其余全是 dsh 的 Web UI）
```

## 路线图

- [x] 首个公开发布 + 更新源（v0.1.0 已发；启动时检查 GitHub Releases，安装前询问并备份）
- [ ] macOS 与 Linux 构建
- [ ] 路线 B：`file://` + IPC 桥接（彻底去掉本地 HTTP 面）

## 致谢

- [DeepSeek AI](https://github.com/deepseek-ai) 与 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)——DSH Desktop 只是他们工作外面的一层薄壳。
- [Electron](https://www.electronjs.org/)、[electron-vite](https://electron-vite.org/)、[electron-builder](https://www.electron.build/)、[pnpm](https://pnpm.io/)。

## 许可证

[MIT](LICENSE) © 2026 qinyre

DSH Desktop 捆绑 [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（MIT）及其依赖；DeepSeek Harness 是 DeepSeek AI 的项目，与本客户端无隶属关系。
