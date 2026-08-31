/**
 * dsh 0.1.2-alpha 起 webserver 全量鉴权（browser-auth.ts）：`/api` 一元 RPC 与
 * `/api/remote.mux` WS 升级都要求带签名会话 cookie；cookie 只能由就绪行 URL 里的
 * 进程令牌经 `GET /?token=…`（303 → /，Set-Cookie：`dsh-auth-<hash>=v1.…`）兑换。
 * 主进程的 fetch/WS 不共享渲染器会话的 cookie jar，须自己持有一份。
 */

/** 兑换成功的 Cookie 请求头值（`name=value`）；失败返回 undefined（调用方按无鉴权旧路降级）。 */
export async function mintSidecarCookie(opts: {
  port: number
  token: string
  fetchImpl?: typeof fetch
}): Promise<string | undefined> {
  const doFetch = opts.fetchImpl ?? fetch
  try {
    const response = await doFetch(`http://127.0.0.1:${String(opts.port)}/?token=${encodeURIComponent(opts.token)}`, {
      redirect: 'manual', // 303 不跟随：我们要的就是响应头里的 Set-Cookie
      signal: AbortSignal.timeout(5000),
    })
    // 兑换失败也是 303 之外的状态（401 等）；只认 mint 成功的形状。
    if (response.status !== 303) return undefined
    const cookies = typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()
      : [response.headers.get('set-cookie') ?? '']
    for (const raw of cookies) {
      const pair = raw.split(';')[0] ?? ''
      const eq = pair.indexOf('=')
      if (eq > 0 && pair.slice(0, eq).startsWith('dsh-auth-')) return pair
    }
    return undefined
  } catch {
    return undefined
  }
}
