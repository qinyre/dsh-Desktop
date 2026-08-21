import './ui.css'
import whaleUrl from '../../../resources/icon.png'

const params = new URLSearchParams(location.search)
const failed = params.get('kind') === 'failed'

document.getElementById('whale')!.setAttribute('src', whaleUrl)

const title = document.getElementById('title')!
const detail = document.getElementById('detail')!
if (failed) {
  document.getElementById('stage')!.classList.add('failed')
  title.textContent = 'dsh 启动失败'
  detail.textContent = params.get('detail') || '详情见日志'
  document.getElementById('retry')!.hidden = false
} else if (params.get('detail')) {
  detail.textContent = params.get('detail')
}

document.getElementById('retry')!.addEventListener('click', () => window.dshDesktop.retry())
document.getElementById('logs')!.addEventListener('click', () => window.dshDesktop.openLogs())

// 启动活动（检查插件完整性 / 预装进度 / 拉起服务）：覆盖 detail 行的静态提示。
// 失败页的 detail 是诊断信息，不被活动文本冲掉。
if (!failed) {
  window.dshDesktop.onActivity((text) => {
    if (text !== '') detail.textContent = text
  })
}
