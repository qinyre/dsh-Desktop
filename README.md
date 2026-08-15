**中文** | [English](README.en.md)

<div align="center">

# DSH Desktop

**[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的免配置桌面客户端**

安装后双击即用，不需要 Node.js、pnpm 或终端。

<!-- TODO: 替换为主窗口真实截图 -->
![DSH Desktop 主窗口](docs/images/screenshot-main.png)

[![CI](https://github.com/qinyre/dsh-Desktop/actions/workflows/ci.yml/badge.svg)](https://github.com/qinyre/dsh-Desktop/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-Windows-lightgrey)
[![Electron](https://img.shields.io/badge/Electron-43-9feaf9?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![dsh](https://img.shields.io/badge/bundles%20dsh-0.1.0--rc.6-4D6BFE)](https://www.npmjs.com/package/@deepseek-ai/dsh)

</div>

---

## 为什么做这个

DeepSeek Harness 自带一流的 Web UI，但它默认你有一台开发者环境：装 Node、装 dsh、开着一个终端、记住端口号。**DSH Desktop 把同一套 Web UI 原封不动地装进原生应用**——自带 Node 运行时和 dsh，让不写代码的人也能双击即用地跑起 agent。

## 特性

- 安装包自带完整运行时（Node、pnpm shim、dsh），机器上什么都不用预装。
- Web UI 原封不动：`dsh web` 的工作区、会话、审批、模型、技能、终端都在应用窗口里，DSH Desktop 只是外面那层壳。
- sidecar 有监督重启（指数退避），进程崩了会自动拉起；dsh 的 append-only 会话日志也保证对话不丢。
- 窗口隐藏或失焦时，等待中的审批和回合结束会弹 Windows 原生通知；关闭到托盘，长任务不占桌面。
- 托盘菜单里有插件管理器，装第三方 dsh 插件不需要机器上有 Node/pnpm。
- 自动更新先询问再装，安装前会备份会话、凭据和设置。

## 安装

从 [**Releases**](https://github.com/qinyre/dsh-Desktop/releases) 下载最新的 `DSH Desktop Setup x.x.x.exe` 运行即可。

<!-- TODO: 首个 Release 发布后补下载徽章/直达链接 -->

环境要求：Windows 10/11 x64。

### 首次运行

应用会启动 sidecar 并打开 dsh Web UI。在 **Settings → Models** 里配置 API key（与 Web UI 相同的引导流程），选好工作区，开聊。

## 插件

dsh 的三层插件能力在 DSH Desktop 里全部保留：

| 层 | 用法 |
|---|---|
| 会话内动态挂载 | 在 Web UI 里选 `cordis` agent preset——agent 运行时自己写插件并挂载，无需重启 |
| 插件清点与配置 | Settings → Plugins，与 Web UI 相同 |
| 第三方插件包 | **托盘 → 插件管理…** |

插件管理器把包安装进应用自己的 profile，例如：

```text
@linxin666/dsh-web-ui-all
```

然后点 **重启生效**。卸载同理。安装输出会流式显示在对话框里，包括 git 托管插件触发 pnpm `allowBuilds` 时的引导提示。

> 安装插件 = 在本机执行第三方代码（pnpm 生命周期脚本），与 dsh CLI 行为一致。请只安装你信任的插件。

## 工作原理

DSH Desktop 是一个 Electron 壳。启动时它通过 `ELECTRON_RUN_AS_NODE` 把 Electron 二进制当作 Node 运行时，拉起子进程 `dsh web --port 0 --host 127.0.0.1`，从 stdout 的就绪行解析出实际端口，再让窗口加载 `http://127.0.0.1:<端口>`。整个应用只有一个运行时，不存在 Node 版本分裂；服务也只绑定随机回环端口，不会暴露到网络。

安全方面有一点要说明：本地 HTTP API 没有鉴权（上游如此设计，Origin 栅栏防的是 DNS rebinding，不是本地进程）。任何以你的用户身份运行的进程都能访问它，但这类进程同样能直接读 dsh 落盘的凭据，所以边际风险限于"本机已被攻陷"这个前提。栅栏的准确范围见上游 [connection 文档](https://github.com/deepseek-ai/deepseek-harness)。

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
DSH_DESKTOP_PLUGIN_SMOKE=1 npm run smoke:plugin   # 干净 PATH 插件安装冒烟（Windows）
npm run check:electron # 断言 Electron 内置 Node 满足 dsh 的 engines 要求
npm run dist           # 构建 NSIS 安装器
```

dev 模式默认从 `../deepseek-harness` 解析上游仓（可用 `DESKTOP_DSH_REPO` 覆盖）；`DESKTOP_DSH_MODE=npm` 切换到捆绑的 npm 包。冒烟在前置条件缺失时自动跳过。

### 目录结构

```text
desktop/
├── src/main/sidecar/     # 进程监督：状态机、运行时解析、日志
├── src/main/windows/     # 窗口控制器、导航锁、状态页
├── src/main/events/      # EventTap：两条下行 WebSocket → 通知
├── src/main/plugins/     # 插件管理器 + 运行时 pnpm shim
├── src/main/tray/        # 托盘
├── src/main/updater/     # electron-updater + DSH_HOME 备份
└── src/renderer/         # 状态页 + 插件对话框（其余全是 dsh 的 Web UI）
```

## 路线图

- [ ] 首个公开发布（图标、签名安装器、更新源）
- [ ] macOS 与 Linux 构建
- [ ] 路线 B：`file://` + IPC 桥接（彻底去掉本地 HTTP 面）

## 致谢

- [DeepSeek AI](https://github.com/deepseek-ai) 与 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)——DSH Desktop 只是他们工作外面的一层薄壳。
- [Electron](https://www.electronjs.org/)、[electron-vite](https://electron-vite.org/)、[electron-builder](https://www.electron.build/)、[pnpm](https://pnpm.io/)。

## 许可证

[MIT](LICENSE) © 2026 qinyre

DSH Desktop 捆绑 [@deepseek-ai/dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)（MIT）及其依赖；DeepSeek Harness 是 DeepSeek AI 的项目，与本客户端无隶属关系。
