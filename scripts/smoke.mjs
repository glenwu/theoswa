// 端到端冒烟：4 个 ws 客户端模拟
// 登录 → 换座 → 确认座位 → 准备 → 抢按揭牌 → 聊天 → 同身份顶替
// 用法：先启动服务端（node server/index.js），再 node scripts/smoke.mjs

import { WebSocket } from 'ws';

const WS_URL = process.env.WS_URL ?? 'ws://localhost:8787/ws';
const HTTP_URL = process.env.HTTP_URL ?? 'http://localhost:8787';
const PLAYERS = ['T', 'H', 'B', 'M'];

let passed = 0;
function assert(cond, name) {
  if (!cond) throw new Error('FAIL ' + name);
  passed += 1;
  console.log('PASS ' + name);
}

function connect(id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const inbox = [];
    const waiters = [];

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      inbox.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].pred(msg)) {
          const w = waiters.splice(i, 1)[0];
          clearTimeout(w.timer);
          w.resolve(msg);
        }
      }
    });
    ws.on('error', reject);

    const client = {
      ws,
      id,
      send: (action) => ws.send(JSON.stringify(action)),
      waitFor: (pred, timeout = 5000) => {
        const found = inbox.find(pred);
        if (found) return Promise.resolve(found);
        return new Promise((res, rej) => {
          const waiter = { pred, resolve: res, timer: null };
          waiter.timer = setTimeout(() => {
            const i = waiters.indexOf(waiter);
            if (i >= 0) waiters.splice(i, 1);
            rej(new Error(`[${id}] 等待消息超时`));
          }, timeout);
          waiters.push(waiter);
        });
      },
      close: () => ws.close(),
    };

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', playerId: id }));
      resolve(client);
    });
  });
}

async function main() {
  // 0. 健康检查
  const health = await (await fetch(`${HTTP_URL}/api/health`)).json();
  assert(health.ok === true, '服务端健康检查');

  // 1. 四人依次登录
  const clients = [];
  for (const id of PLAYERS) clients.push(await connect(id));
  const byId = Object.fromEntries(clients.map(c => [c.id, c]));
  for (const c of clients) await c.waitFor(m => m.type === 'state');
  assert(true, '四人都收到初始状态');

  const occ = await (await fetch(`${HTTP_URL}/api/occupancy`)).json();
  assert(occ.occupied.length === 4, '占用身份 4/4');

  // 2. 换座：T 向 H 请求，H 接受
  const stT = (await byId.T.waitFor(m => m.type === 'state')).state;
  const stH = (await byId.H.waitFor(m => m.type === 'state')).state;
  const tSeat = stT.you.seat;
  const hSeat = stH.you.seat;
  byId.T.send({ type: 'proposeSwap', targetSeat: hSeat });
  await byId.H.waitFor(
    m => m.type === 'state' && m.state.swapProposals.some(sp => sp.fromSeat === tSeat && sp.toSeat === hSeat)
  );
  byId.H.send({ type: 'acceptSwap', fromSeat: tSeat });
  await byId.T.waitFor(m => m.type === 'state' && m.state.you.seat === hSeat);
  assert(true, 'T/H 换座成功');

  // 3. 全员确认座位 → READY_CHECK
  for (const c of clients) c.send({ type: 'confirmSeat' });
  await byId.T.waitFor(m => m.type === 'state' && m.state.phase === 'READY_CHECK');
  assert(true, '四人确认座位 → READY_CHECK');

  // 4. 全员准备 → REVEAL_FIRST
  for (const c of clients) c.send({ type: 'ready' });
  await byId.T.waitFor(m => m.type === 'state' && m.state.phase === 'REVEAL_FIRST');
  assert(true, '全员准备 → REVEAL_FIRST');

  // 5. 抢按揭牌：先到成功、后到 FLIPPER_ALREADY_CLAIMED
  byId.T.send({ type: 'claimFlipper' });
  await byId.T.waitFor(m => m.type === 'state' && m.state.flipperSeat !== null);
  byId.B.send({ type: 'claimFlipper' });
  const err = await byId.B.waitFor(m => m.type === 'error');
  assert(err.code === 'FLIPPER_ALREADY_CLAIMED', '后到者收到 FLIPPER_ALREADY_CLAIMED');

  // 6. 聊天与快捷短语广播
  byId.T.send({ type: 'chat', text: '大家好！' });
  await byId.M.waitFor(m => m.type === 'state' && m.state.chat.some(x => x.text === '大家好！'));
  byId.B.send({ type: 'quickChat', phraseId: 'mengmeng' });
  await byId.H.waitFor(m => m.type === 'state' && m.state.chat.some(x => x.text === '猛猛呐'));
  assert(true, '聊天与快捷短语广播');

  // 7. 同身份新连接顶替旧连接（断线重连路径）
  const t2 = await connect('T');
  const kicked = await byId.T.waitFor(m => m.type === 'kicked');
  assert(kicked.reason === '你已在别处登录', '旧 T 收到顶替提示');
  await t2.waitFor(m => m.type === 'state' && m.state.you.id === 'T');
  assert(true, '新 T 收到裁剪状态（重连恢复局面）');

  console.log(`\nSMOKE OK（${passed} 项全部通过）`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
