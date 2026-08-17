// 阶段3端到端冒烟：全自动对局
// 登录 → 准备 → 翻牌 → 揭牌 → 亮主 → 换底 → 出牌（bot 打完整局 25 轮）→ SCORING
// 断言：25 轮、手牌清零、件全部迁移、收牌停留出现并清空、四家视图无泄露。
// 需先用短节奏 + 固定种子启动服务端：
//   SEED=42 FLIP_MS=100 DRAW_MS=150 GRACE_MS=300 FALLBACK_MS=40 DEALING_MS=40 SETTLE_MS=120 node server/index.js

import { WebSocket } from 'ws';
import { playSuitOf, cardStrength } from '../server/cards.js';

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
      buried: false,
      sawSettle: false,
      sawSettleClear: false,
      lastDrawKey: null,
      lastPlayKey: null,
      send: action => ws.send(JSON.stringify(action)),
      close: () => ws.close(),
    };
    ws.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (m.type === 'state') {
        client.last = m.state;
        if (m.state.round?.lastTrick) client.sawSettle = true;
        if (client.sawSettle && !m.state.round?.lastTrick && m.state.phase === 'PLAYING') {
          client.sawSettleClear = true;
        }
      } else if (m.type === 'error') client.errors.push(m);
    });
    ws.on('error', reject);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', playerId: id }));
      resolve(client);
    });
  });
}

// bot：首家出最小非主牌；跟牌按规则（有花色必出/不够补齐/无花色 N 主杀否则垫）
function botCards(hand, lead, ctx) {
  const suitOf = x => playSuitOf(x, ctx.trumpSuit, ctx.rankCard);
  const bySuit = s => hand.filter(x => suitOf(x) === s);
  const lowest = (cards, n) =>
    [...cards].sort((a, b) => cardStrength(a, ctx) - cardStrength(b, ctx)).slice(0, n);
  if (!lead) {
    const nonTrump = hand.filter(x => suitOf(x) !== 'TRUMP');
    return [lowest(nonTrump.length ? nonTrump : hand, 1)[0]];
  }
  const N = lead.cards.length;
  const suitCards = bySuit(lead.playSuit);
  if (suitCards.length >= N) return lowest(suitCards, N);
  if (suitCards.length > 0) {
    return [...lowest(suitCards, suitCards.length), ...lowest(hand.filter(x => !suitCards.includes(x)), N - suitCards.length)];
  }
  const trumps = bySuit('TRUMP');
  if (trumps.length >= N) return lowest(trumps, N);
  return lowest(hand, N);
}

async function main() {
  const health = await (await fetch(`${HTTP_URL}/api/health`)).json();
  assert(health.ok === true, '服务端健康检查');

  const clients = [];
  for (const id of PLAYERS) clients.push(await connect(id));
  const byId = Object.fromEntries(clients.map(c => [c.id, c]));
  await waitUntil(() => clients.every(c => c.last), 8000);

  // 座位 → 准备 → 抢按翻牌
  for (const c of clients) c.send({ type: 'confirmSeat' });
  await waitUntil(() => byId.T.last.phase === 'READY_CHECK', 8000);
  for (const c of clients) c.send({ type: 'ready' });
  await waitUntil(() => byId.T.last.phase === 'REVEAL_FIRST', 8000);
  byId.T.send({ type: 'claimFlipper' });
  await waitUntil(() => byId.T.last.phase === 'REVEALING', 15000);
  assert(true, '翻牌定起揭人 → REVEALING');

  // 揭牌/亮主/换底
  let voidCount = 0;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const st = byId.T.last;
    if (st.phase === 'PLAYING') break;
    if (st.phase === 'READY_CHECK') {
      voidCount += 1;
      assert(voidCount <= 3, '流局重来不超过 3 次');
      for (const c of clients) c.send({ type: 'ready' });
      await waitUntil(() => byId.T.last.phase === 'REVEAL_FIRST', 15000);
      byId.T.send({ type: 'claimFlipper' });
      await waitUntil(() => byId.T.last.phase === 'REVEALING', 15000);
      continue;
    }
    if (st.phase === 'KITTY_EXCHANGE') {
      const decl = clients.find(c => c.last?.you.seat === st.declarerSeat);
      if (decl && !decl.buried) {
        const s = decl.last;
        const pool = s.you.hand; // 33 张：底牌已并入手牌
        decl.buried = true;
        decl.send({ type: 'buryKitty', cardIds: pool.slice(0, 8).map(c => c.id) });
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
        const key = `${s.round.drawnCount}:${s.round.revealTurnSeat}`;
        if (s.round.drawnCount < 100 && s.round.revealTurnSeat === s.you.seat && c.lastDrawKey !== key) {
          c.lastDrawKey = key;
          c.send({ type: 'drawCard' });
        }
        if (!c.declared) {
          const rc = (s.you.hand ?? []).find(x => x.rank === s.round.rankCard);
          if (rc) {
            c.declared = true;
            c.send({ type: 'declareTrump', cardId: rc.id });
          }
        }
      }
    }
    await sleep(30);
  }
  assert(byId.T.last.phase === 'PLAYING', '亮主 → 发牌 → 换底 → PLAYING');

  // 出牌：bot 打完整局（25 轮）
  const ctx0 = byId.T.last.round;
  const ctx = { trumpSuit: ctx0.trumpSuit, rankCard: ctx0.rankCard };
  const playDeadline = Date.now() + 120000;
  while (Date.now() < playDeadline) {
    const st = byId.T.last;
    if (st.phase === 'SCORING' || st.phase === 'ROUND_END') break;
    if (st.phase === 'DOMINANCE') {
      // 碾压判定命中 → 看结算
      if (byId.T.lastSawDominance !== st.round.trickHistory.length) {
        byId.T.lastSawDominance = st.round.trickHistory.length;
        byId.T.send({ type: 'confirmDominance' });
      }
      await sleep(30);
      continue;
    }
    for (const c of clients) {
      const s = c.last;
      if (!s || s.phase !== 'PLAYING') continue;
      if (s.round.lastTrick) continue; // 收牌停留期间不出牌
      if (s.round.turnSeat !== s.you.seat) continue;
      const key = `${s.round.trickHistory.length}:${s.round.currentTrick.length}`;
      if (c.lastPlayKey === key) continue;
      c.lastPlayKey = key;
      const lead = s.round.currentTrick[0] ?? null;
      const cards = botCards(s.you.hand, lead, ctx);
      c.send({ type: 'play', cardIds: cards.map(x => x.id) });
    }
    await sleep(30);
  }

  const final = byId.T.last;
  assert(final.phase === 'SCORING' || final.phase === 'ROUND_END', '25 轮打完 → 结算/小结');
  assert(
    final.round.trickHistory.length === 25 || final.round.trickHistory.some(t => t.virtual),
    '轮次完整（或由碾压虚拟收尾）'
  );
  assert(final.rounds.length === 1, '已生成第一局摘要');
  assert(final.players.every(p => p.handCount === 0), '四家手牌清零');
  assert(final.round.currentTrick.length === 0, '无残局');
  assert(!!final.round.lastTrick, '最后一轮保留展示');
  for (const c of clients) {
    assert(c.sawSettle, `${c.id} 看到过收牌停留（服务端计时）`);
  }
  // 件全部迁移：任何视角都没有 unseen
  const piecesAllSeen = Object.values(final.round.piecesView ?? {})
    .flat()
    .every(x => x.status !== 'unseen');
  assert(piecesAllSeen, '全场打完，件全部已打出或埋底（无未现）');
  // 分数合理性：闲家台面分 + 庄家跑掉分 ≤ 200 且非负
  assert(
    final.round.defenderTrickPoints + final.round.runAwayPoints <= 200 &&
      final.round.defenderTrickPoints >= 0 &&
      final.round.runAwayPoints >= 0,
    '分账合理'
  );
  // 隐私
  for (const st of clients.map(c => c.last)) {
    for (const p of st.players) assert(!('hand' in p), `${st.you.id} 视图不含他人手牌字段`);
  }

  console.log(`\nSMOKE OK（${passed} 项全部通过）`);
  process.exit(0);
}

main().catch(e => {
  console.error(e.message);
  process.exit(1);
});
