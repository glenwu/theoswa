// 阶段2端到端冒烟（流局路径）：
// 全程不主动揭牌、不亮主 → 100 张靠超时自动摸完 → 宽限窗口结束无人亮主
// → 第一局流局 → READY_CHECK（局数不变、级别不变、庄家仍为 null）
// → 再次全员准备 → 仍走 REVEAL_FIRST（流局后仍走 REVEAL_FIRST 的实机验证）
// 需先用短节奏环境变量启动服务端：
//   FLIP_MS=50 DRAW_MS=60 GRACE_MS=200 FALLBACK_MS=40 DEALING_MS=40 node server/index.js

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
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitUntil(cond, timeout, interval = 50) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (cond()) return;
    await sleep(interval);
  }
  throw new Error('等待超时');
}

function connect(id) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const client = {
      id,
      ws,
      last: null,
      send: action => ws.send(JSON.stringify(action)),
      close: () => ws.close(),
    };
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'state') client.last = m.state;
    });
    ws.on('error', reject);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', playerId: id }));
      resolve(client);
    });
  });
}

async function main() {
  const health = await (await fetch(`${HTTP_URL}/api/health`)).json();
  assert(health.ok === true, '服务端健康检查');

  const clients = [];
  for (const id of PLAYERS) clients.push(await connect(id));
  const byId = Object.fromEntries(clients.map(c => [c.id, c]));
  await waitUntil(() => clients.every(c => c.last), 8000);

  for (const c of clients) c.send({ type: 'confirmSeat' });
  await waitUntil(() => byId.T.last.phase === 'READY_CHECK', 8000);
  for (const c of clients) c.send({ type: 'ready' });
  await waitUntil(() => byId.T.last.phase === 'REVEAL_FIRST', 8000);
  byId.T.send({ type: 'claimFlipper' });
  await waitUntil(() => byId.T.last.phase === 'REVEALING', 15000);
  assert(true, '进入 REVEALING');

  // 全程不揭牌、不亮主：等超时自动摸完 100 张 + 宽限结束 → 流局
  await waitUntil(() => byId.T.last.phase === 'READY_CHECK', 30000, 100);
  const voided = byId.T.last;
  assert(voided.phase === 'READY_CHECK', '100张揭完无人亮主 → 流局回 READY_CHECK');
  assert(voided.round.roundNumber === 1, '流局不递增局数');
  assert(voided.declarerSeat === null, '庄家仍为 null');
  assert(JSON.stringify(voided.teamLevels) === '[0,0]', '级别不变');
  assert(voided.players.every(p => p.handCount === 0), '不发牌，四家手牌清零');

  // 流局后再准备 → 仍走 REVEAL_FIRST（庄家未定判据，与局数无关）
  for (const c of clients) c.send({ type: 'ready' });
  await waitUntil(() => byId.T.last.phase === 'REVEAL_FIRST', 10000);
  assert(true, '流局后再准备 → 仍走 REVEAL_FIRST（庄家未定判据）');

  console.log(`\nSMOKE OK（${passed} 项全部通过）`);
  process.exit(0);
}

main().catch(e => {
  console.error(e.message);
  process.exit(1);
});
