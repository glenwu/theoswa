// 阶段2端到端冒烟（happy path）：
// 登录 → 确认座位 → 准备 → 抢按翻牌 → 逐张揭牌 → 抢按亮主 → 发牌 → 庄家换底 → 进入 PLAYING
// 同时验证手牌隐私（任何客户端的 payload 都不含其他三家的牌）。
// 需先用短节奏环境变量启动服务端：
//   FLIP_MS=100 DRAW_MS=250 GRACE_MS=400 FALLBACK_MS=40 DEALING_MS=40 node server/index.js

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
      errors: [],
      declared: false,
      declaredCard: null,
      buried: false,
      buriedPieces: [],
      lastDrawKey: null,
      send: action => ws.send(JSON.stringify(action)),
      close: () => ws.close(),
    };
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'state') client.last = m.state;
      else if (m.type === 'error') client.errors.push(m);
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
  assert(true, '四人都收到初始状态');

  // 座位 → 准备 → 抢按翻牌
  for (const c of clients) c.send({ type: 'confirmSeat' });
  await waitUntil(() => clients.every(c => c.last.phase === 'READY_CHECK'), 8000);
  for (const c of clients) c.send({ type: 'ready' });
  await waitUntil(() => clients.every(c => c.last.phase === 'REVEAL_FIRST'), 8000);
  byId.T.send({ type: 'claimFlipper' });
  await waitUntil(() => clients.every(c => c.last.phase === 'REVEALING'), 15000);
  assert(true, '抢按翻牌 → 系统翻牌定起揭人 → REVEALING');

  // 揭牌 / 亮主 / 换底：状态驱动循环
  let voidCount = 0;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const st = byId.T.last;
    if (st.phase === 'PLAYING') break;

    if (st.phase === 'READY_CHECK') {
      // 第一局无人亮主 → 流局（极罕见：8 张级牌全在底牌）
      voidCount += 1;
      assert(voidCount <= 3, '流局重来不超过 3 次');
      for (const c of clients) c.send({ type: 'ready' });
      await waitUntil(() => byId.T.last.phase === 'REVEAL_FIRST', 15000);
      byId.T.send({ type: 'claimFlipper' });
      await waitUntil(() => byId.T.last.phase === 'REVEALING', 15000);
      continue;
    }

    if (st.phase === 'KITTY_EXCHANGE') {
      const declClient = clients.find(c => c.last?.you.seat === st.declarerSeat);
      if (declClient && !declClient.buried) {
        const s = declClient.last;
        const pool = s.you.hand; // 33 张：底牌已并入手牌统一排序
        const pieces = pool.filter(
          c => c.suit !== s.round.trumpSuit && (c.rank === 13 || c.rank === 14)
        );
        const buried =
          pieces.length >= 8
            ? pieces.slice(0, 8)
            : [...pieces, ...pool.filter(c => !pieces.includes(c)).slice(0, 8 - pieces.length)];
        assert(buried.length === 8, '庄家可选出 8 张埋底');
        declClient.buried = true;
        declClient.buriedPieces = buried.filter(
          c => c.suit !== s.round.trumpSuit && (c.rank === 13 || c.rank === 14)
        );
        declClient.send({ type: 'buryKitty', cardIds: buried.map(c => c.id) });
      }
      await sleep(50);
      continue;
    }


    if (st.phase === 'CROSS_RIVER') {
      // 三主过河：bot 全部跳过（服务端决定窗口结束也会自动跳过）
      for (const c of clients) {
        const s = c.last;
        if (!s || s.phase !== 'CROSS_RIVER') continue;
        const roundNo = s.round?.roundNumber;
        if (roundNo != null && c.skippedRiverRound === roundNo) continue;
        if (s.you.crossRiver?.eligible) {
          c.skippedRiverRound = roundNo;
          c.send({ type: 'skipCrossRiver' });
        }
      }
      await sleep(30);
      continue;
    }
    if (st.phase === 'REVEALING') {
      for (const c of clients) {
        const s = c.last;
        if (!s || s.phase !== 'REVEALING') continue;
        // 轮到自己就揭牌（加速；超时自动摸由服务端兜底）
        const key = `${s.round.drawnCount}:${s.round.revealTurnSeat}`;
        if (s.round.drawnCount < 100 && s.round.revealTurnSeat === s.you.seat && c.lastDrawKey !== key) {
          c.lastDrawKey = key;
          c.send({ type: 'drawCard' });
        }
        // 手上有级牌就亮主（服务端裁决先后）
        if (!c.declared) {
          const rc = (s.you.hand ?? []).find(x => x.rank === s.round.rankCard);
          if (rc) {
            c.declared = true;
            c.declaredCard = rc;
            c.send({ type: 'declareTrump', cardId: rc.id });
          }
        }
      }
    }
    await sleep(30);
  }

  // 最终断言
  const finals = clients.map(c => c.last);
  assert(finals.every(f => f && f.phase === 'PLAYING'), '亮主 → 发牌 → 换底 → PLAYING');
  const trumpSuit = finals[0].round.trumpSuit;
  assert(!!trumpSuit, '主牌花色已定');
  const declarerSeat = finals[0].declarerSeat;
  assert(declarerSeat !== null, '第一局亮主者成为庄家');
  const declarerClient = clients.find(c => c.last.you.seat === declarerSeat);
  assert(declarerClient.declared, '庄家就是亮主的那位玩家');

  for (const st of finals) {
    assert(st.you.hand.length === 25, `${st.you.id} 手牌 25 张`);
    assert(st.round.kittyCount === 8, `${st.you.id} 底牌 8 张`);
    assert(!!st.round.piecesView, `${st.you.id} 件追踪面板数据就绪`);
    assert(!!st.you.composition, `${st.you.id} 有自己的手牌构成`);
    for (const p of st.players) {
      assert(!('hand' in p), `${st.you.id} 视图不含他人手牌字段`);
      assert(!('composition' in p), `${st.you.id} 视图不含他人手牌构成`);
      assert(p.handCount === 25, `${st.you.id} 视图：${p.id} 手牌数 25`);
    }
  }
  // 隐私强断言：四家手牌 id 互不相交（共 100 张互不相同）
  const allIds = new Set(finals.flatMap(st => st.you.hand.map(c => c.id)));
  assert(allIds.size === 100, '四家手牌 id 互不重复（无泄露/无重复）');
  // 若埋入了件，应有公开亮件播报
  if (declarerClient.buriedPieces.length > 0) {
    const hasLog = finals[0].log.some(l => l.text.includes('庄家埋底亮出'));
    assert(hasLog, '埋入副牌 A/K 后全桌可见公开播报');
  }

  console.log(`\nSMOKE OK（${passed} 项全部通过）`);
  process.exit(0);
}

main().catch(e => {
  console.error(e.message);
  process.exit(1);
});
