// 一次性探针：Electron 主进程的 WebSocket 是否透传自定义 headers（决定 EventTap
// 如何向 remote.mux 升级呈递 cookie）。Electron ≥29 主进程的 WebSocket 走 Chromium
// 网络栈；Node/undici 的实现接受 {headers} 非标第三参。这里起本地 upgrade 服务端
// 实测。用法：electron scripts/ws-headers-probe.cjs
const http = require('node:http')
const crypto = require('node:crypto')
const { app } = require('electron')

app.whenReady().then(() => {
  const server = http.createServer()
  server.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    console.log('PROBE_COOKIE=' + JSON.stringify(req.headers.cookie ?? null))
    setTimeout(() => { socket.destroy(); server.close(); app.quit() }, 400)
  })
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    console.log('WEBSOCKET_IMPL=' + (typeof WebSocket === 'function' ? 'present' : 'missing'))
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { headers: { cookie: 'dsh-auth-probe=v1.sent' } })
    ws.addEventListener('error', (event) => { console.log('PROBE_ERROR=' + (event.message ?? 'unknown')); app.quit() })
  })
})
