/** 关闭按钮决策（设计书 §5）。首次气泡提示由 TrayController 自己的 flag 管理，与本决策无关。 */
export function closeAction(opts: { quiting: boolean }): 'hide' | 'quit' {
  return opts.quiting ? 'quit' : 'hide'
}
