import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const root = fileURLToPath(new URL('../../', import.meta.url));
const password = 'auth-regression-only';

// 使用独立临时存档和回环端口，不读取开发中或正在玩的牌局。
async function startServer(t, gamePassword = password) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'chaoshan-auth-'));
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1', PORT: String(port), GAME_PASSWORD: gamePassword,
      SAVE_FILE: path.join(dir, 'save.json'), ADMIN_RESET_TOKEN: '', DEBUG: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exited = once(child, 'exit');
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await exited;
  };
  t.after(async () => {
    await stop();
    await rm(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('登录测试服务启动超时')), 5000);
    let output = '';
    child.stdout.on('data', data => {
      output += data;
      if (output.includes('服务端已启动')) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on('data', data => { output += data; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(output)); });
  });
  return { base: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}/ws`, stop };
}

async function handshake(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers, handshakeTimeout: 3000 });
    ws.on('error', reject);
    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode;
      res.resume();
      resolve(status);
      ws.terminate();
    });
    ws.on('open', () => { ws.close(); resolve(101); });
  });
}

test('进门密码：HTTP 与 WebSocket 拒绝匿名访问，密码登录和 Basic Auth 均可进入', { timeout: 15000 }, async t => {
  const { base, wsUrl } = await startServer(t);
  let response = await fetch(base, { headers: { Accept: 'text/html' } });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), null, '页面不能触发浏览器原生密码框');
  assert.match(await response.text(), /进门密码/);
  response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate'), /^Basic /);
  assert.equal(await handshake(wsUrl), 401);

  response = await fetch(`${base}/api/login`, {
    method: 'POST', body: new URLSearchParams({ password: 'wrong' }), redirect: 'manual',
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), null);

  response = await fetch(`${base}/api/login`, {
    method: 'POST', body: new URLSearchParams({ password }), redirect: 'manual',
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/');
  const setCookie = response.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/);
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Max-Age=2592000/);
  const Cookie = setCookie.split(';')[0];
  for (const headers of [
    { Cookie },
    { Authorization: `Basic ${Buffer.from(`friend:${password}`).toString('base64')}` },
  ]) {
    response = await fetch(`${base}/api/health`, { headers });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ok, true);
    assert.equal(await handshake(wsUrl, headers), 101);
  }
  for (const headers of [
    { Cookie: 'chaoshan_session=forged' },
    { Authorization: `Basic ${Buffer.from('friend:wrong').toString('base64')}` },
  ]) {
    assert.equal((await fetch(`${base}/api/health`, { headers })).status, 401);
    assert.equal(await handshake(wsUrl, headers), 401);
  }
});

test('进门密码：重启后旧 Cookie 在页面和 WebSocket 均失效，供客户端重新登录', { timeout: 15000 }, async t => {
  const before = await startServer(t);
  const response = await fetch(`${before.base}/api/login`, {
    method: 'POST', body: new URLSearchParams({ password }), redirect: 'manual',
  });
  assert.equal(response.status, 302);
  const Cookie = response.headers.get('set-cookie').split(';')[0];
  await before.stop();
  const after = await startServer(t);
  assert.equal((await fetch(after.base, { headers: { Cookie, Accept: 'text/html' } })).status, 401);
  assert.equal(await handshake(after.wsUrl, { Cookie }), 401);
});

test('未配置进门密码：HTTP 与 WebSocket 保持原有可访问行为', { timeout: 15000 }, async t => {
  const { base, wsUrl } = await startServer(t, '');
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal(await handshake(wsUrl), 101);
});
