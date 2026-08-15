const params = new URLSearchParams(location.search)
const kind = params.get('kind') ?? 'launching'
const msg = document.getElementById('msg')!
msg.textContent = kind === 'failed' ? 'dsh 启动失败' : '正在启动 dsh…'
if (params.get('detail')) msg.textContent += `\n${params.get('detail')}`
document.getElementById('retry')!.style.display = kind === 'failed' ? 'inline' : 'none'
document.getElementById('retry')!.addEventListener('click', () => window.dosket.retry())
document.getElementById('logs')!.addEventListener('click', () => window.dosket.openLogs())
