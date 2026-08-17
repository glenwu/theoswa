// WebSocket 客户端：自动重连、顶替提示、状态订阅。
// 同身份新连接会在服务端顶替旧连接；本端收到 kicked 后停止重连。
// joinPayload 附加在 join 消息上（如管理员口令 adminToken）。

export function createConnection(identity, { onState, onError, onKicked, joinPayload = {} }) {
  let ws = null;
  let stopped = false;
  let retryTimer = null;
  let retryDelay = 1500;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);

    ws.onopen = () => {
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
      if (!stopped) {
        retryTimer = setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 10000);
      }
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
