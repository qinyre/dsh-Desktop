/** 仅窗口隐藏或失焦时弹通知（设计书 §6）。 */
export function shouldNotify(visible: boolean, focused: boolean): boolean {
  return !visible || !focused
}
