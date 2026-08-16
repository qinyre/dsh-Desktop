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
