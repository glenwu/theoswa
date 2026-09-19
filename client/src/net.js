// WebSocket 客户端：自动重连、顶替提示、状态订阅。
// 同身份新连接会在服务端顶替旧连接；本端收到 kicked 后停止重连。
// joinPayload 附加在 join 消息上（如管理员口令 adminToken）。

// 进门密码的登录会话存在服务端内存里，服务重启就清空（server/index.js 的设计）。
// 没刷新的旧页面拿着失效的 Cookie 去重连，WebSocket 握手被 401 拒掉 —— 可浏览器
// 只给一个 close，读不到状态码，于是一直重连，卡在「正在连接房间」（Glen 手机上遇到过）。
// 握手没成功时用普通请求问一句：401 就是登录失效了。
// ⚠️ 必须带 Accept: text/html：不带的话服务端回的是 Basic 质询，浏览器会弹原生密码框，
// 而登录页正是为了不弹那个框才做的。
// 服务端还没起来（重启中）时请求直接失败，返回 false，接着重连。
export async function sessionExpired(fetchImpl = globalThis.fetch) {
  try {
    const res = await fetchImpl('/', {
      headers: { Accept: 'text/html' },
      cache: 'no-store',
      credentials: 'same-origin',
    });
    return res.status === 401;
  } catch {
    return false;
  }
}

export function createConnection(identity, { onState, onError, onKicked, joinPayload = {} }) {
  let ws = null;
  let stopped = false;
  let retryTimer = null;
  let retryDelay = 1500;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    let opened = false;

    ws.onopen = () => {
      opened = true;
      retryDelay = 1500;
      ws.send(JSON.stringify({ type: 'join', playerId: identity, ...joinPayload }));
    };
    ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'state') onState(msg.state);
      else if (msg.type === 'error') onError(msg);
      else if (msg.type === 'kicked') {
        stopped = true; // 被顶替：不再重连
        onKicked(msg.reason);
        try { ws.close(); } catch { /* 忽略 */ }
      }
    };
    ws.onclose = () => {
      if (stopped) return;
      // 握手就没成功：先看是不是登录失效了，是就刷新，让登录页出来
      if (!opened) {
        sessionExpired().then(expired => {
          if (expired && !stopped) location.reload();
        });
      }
      retryTimer = setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 10000);
    };
    ws.onerror = () => {
      try { ws.close(); } catch { /* 忽略 */ }
    };
  }

  connect();

  return {
    send(action) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(action));
    },
    close() {
      stopped = true;
      clearTimeout(retryTimer);
      try { ws.close(); } catch { /* 忽略 */ }
    },
  };
}
