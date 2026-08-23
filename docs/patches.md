# 已知补丁

`desktop/patches/` 下的五个补丁文件对应三个逻辑修复，经 pnpm patchedDependencies（`desktop/package.json`）声明，`pnpm install` 时自动应用。补丁按精确版本生成，升级 dsh 使补丁失配时 pnpm 会在安装阶段报错，不会静默失效——此时需用 `pnpm patch` 重新生成补丁再 `pnpm patch-commit`；大偏移的旧补丁 git apply / GNU patch 会默默接受，但 pnpm 的 patch 框架拒绝，必须走重生成而非手工续补。

| 补丁文件 | 逻辑修复 |
|---|---|
| `@deepseek-ai__dsh-app-boot` | 启动永不砖 |
| `@deepseek-ai__dsh-host-directory-picker-native` | 目录选择器 |
| `@deepseek-ai__dsh-subprocess-local` | 子进程黑窗（node 层，三处调用点） |
| `@deepseek-ai__dsh-sandbox-windows-acl` | 子进程黑窗（原生运行器层） |
| `@deepseek-ai__dsh` | 子进程黑窗（CLI 的插件转发器） |

## 启动永不砖 · dsh-app-boot

profile 声明的 bundle 在磁盘上缺件时（插件更新被中途打断的典型残骸），dsh 的 loader 会在导入阶段抛错、整树拒绝启动。补丁把单个 bundle 的解析失败降级为跳过 + 告警，配合应用层的启动前审计、崩溃自愈器与插件守卫，损坏的插件不再导致整个应用无法启动。

## 目录选择器 · dsh-host-directory-picker-native（koffi）

dsh 的 Win32 目录选择 worker 原先用 `koffi.view()` 读取所选路径，该调用在 Electron 内嵌 Node 下会触发致命错误（`Error::New napi_get_last_error_info`，普通 Node 不受影响），打包版选择工作区文件夹后会报 "win32 folder dialog worker exited before reporting a result"。补丁将读取改为逐单元的 `koffi.decode()`；`pnpm run smoke:picker` 会在真实 `ELECTRON_RUN_AS_NODE` 子进程中验证。

## 子进程黑窗 · windowsHide / SW_HIDE

修复分两层。

其一，dsh 的子进程执行——agent 工具的 spawn、进程树终止的 taskkill、插件安装的 pnpm 调用（含 CLI 的插件转发器）——都没设 `windowsHide: true`。在终端里运行 dsh 时子进程继承当前控制台无感知，但 DSH Desktop 是 GUI 进程、没有控制台可继承，每次调用都会弹出黑色控制台窗口，补丁为四处补上（三处在 dsh-subprocess-local，一处在 dsh 的插件转发器）。

其二，Windows 沙箱运行器（受限令牌）用原生 `CreateProcessAsUserW` 拉起真正的命令，自动创建的控制台窗口不受 node 选项控制——补丁在 STARTUPINFO 里加 `STARTF_USESHOWWINDOW|SW_HIDE` 隐藏该窗口。

不采用 CREATE_NO_WINDOW / DETACHED_PROCESS 的原因：实测二者会让 PowerShell（5.1 与 7 均是）在无控制台环境下静默丢弃管道输出（cmd 不受影响）。`pnpm run smoke:hideconsole` 覆盖两层：断言补丁在位，并在真实 `ELECTRON_RUN_AS_NODE` 子进程里经 dsh 公开的 subprocess API 与真实 ACL 运行器运行 powershell，验证输出收集与终止路径。
