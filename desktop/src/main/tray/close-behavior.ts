/**
 * 关闭按钮决策（设计书 §5）。首次气泡提示由 TrayController 自己的 flag 管理，与本决策无关。
 * trayAvailable=false（Linux 无 StatusNotifierItem 宿主/探测未知）：隐藏后没有任何入口能找回
 * 窗口（托盘不在、任务栏无窗），只能杀进程——此时关闭=真实退出（放行 close 事件，
 * 走 window-all-closed 默认 quit 链，与托盘菜单退出共用路径）。
 */
export function closeAction(opts: { quiting: boolean; trayAvailable: boolean }): 'hide' | 'quit' {
  return opts.quiting || !opts.trayAvailable ? 'quit' : 'hide'
}
