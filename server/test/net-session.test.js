import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sessionExpired, createConnection } from '../../client/src/net.js';

// Glen 2026-09-19：服务重启后手机一直「正在连接房间」—— 登录会话存在内存里，
// 重启就清空；WebSocket 握手被 401 拒掉，浏览器却只给一个 close。

test('登录失效探测：401 才算失效；200、服务端没起来都不算', async () => {
  assert.equal(await sessionExpired(async () => ({ status: 401 })), true);
  assert.equal(await sessionExpired(async () => ({ status: 200 })), false);
  assert.equal(await sessionExpired(async () => { throw new TypeError('Failed to fetch'); }), false);
});

test('登录失效探测：带 Accept: text/html，不触发浏览器的原生密码框', async () => {
  let seen = null;
  await sessionExpired(async (url, init) => { seen = { url, init }; return { status: 200 }; });
  assert.equal(seen.url, '/');
  assert.equal(seen.init.headers.Accept, 'text/html');
});

// 用假的 WebSocket / location / fetch 跑一遍重连：握手没成功 + 401 → 刷新页面。
function withFakeBrowser({ status, handshakeOk }, fn) {
  const saved = {
    WebSocket: globalThis.WebSocket, location: globalThis.location, fetch: globalThis.fetch,
  };
  let reloads = 0;
  const sockets = [];
  globalThis.location = { protocol: 'http:', host: 'x', reload: () => { reloads += 1; } };
  globalThis.fetch = async () => ({ status });
  globalThis.WebSocket = class {
    constructor() {
      sockets.push(this);
      queueMicrotask(() => {
        if (handshakeOk) this.onopen?.();
        this.onclose?.();
      });
    }
    send() {}
    close() {}
  };
  return fn({ sockets, reloads: () => reloads }).finally(() => {
    Object.assign(globalThis, saved);
  });
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('握手被拒、登录已失效 → 刷新页面（登录页出来），不再无限重连', async () => {
  await withFakeBrowser({ status: 401, handshakeOk: false }, async ({ reloads }) => {
    const conn = createConnection('A', { onState() {}, onError() {}, onKicked() {} });
    await tick(); await tick();
    conn.close();
    assert.equal(reloads(), 1);
  });
});

test('握手被拒但登录还有效（多半是服务端在重启）→ 不刷新，接着重连', async () => {
  await withFakeBrowser({ status: 200, handshakeOk: false }, async ({ reloads }) => {
    const conn = createConnection('A', { onState() {}, onError() {}, onKicked() {} });
    await tick(); await tick();
    conn.close();
    assert.equal(reloads(), 0);
  });
});

test('连上过又断开（正常掉线）→ 不去探测，也不刷新', async () => {
  await withFakeBrowser({ status: 401, handshakeOk: true }, async ({ reloads }) => {
    const conn = createConnection('A', { onState() {}, onError() {}, onKicked() {} });
    await tick(); await tick();
    conn.close();
    assert.equal(reloads(), 0);
  });
});
