// 阶段4端到端冒烟：多局连打至 GAME_OVER，逐局打印 RoundSummary（录像式日志）。
// 用固定种子复现：SEED=<n> 启动后运行本脚本，输出可人工复核算分。
// 服务端节奏：
//   SEED=42 FLIP_MS=100 DRAW_MS=120 GRACE_MS=250 FALLBACK_MS=30 DEALING_MS=30
//   SETTLE_MS=100 SCORING_MS=150 ROUND_END_MS=200 node server/index.js

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

async function waitUntil(cond, timeout, interval = 40) {
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
      declared: false,
      buried: false,
      lastDrawKey: null,
      lastPlayKey: null,
      lastReadyRound: 0,
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

  // 首局：座位 + 准备
  for (const c of clients) c.send({ type: 'confirmSeat' });
  await waitUntil(() => byId.T.last.phase === 'READY_CHECK', 8000);

  const rankCardByRound = {}; // 每局开始时的级牌（用于录像日志的“下局打X”）
  let lastLogged = '';
  const logPhase = () => {
    const st = byId.T.last;
    const r = st.round ?? {};
    const key = `${st.phase}|${r.roundNumber}|drawn=${r.drawnCount}|tricks=${r.trickHistory?.length ?? '-'}|turn=${r.turnSeat}|lastTrick=${!!r.lastTrick}`;
    if (key !== lastLogged) {
      lastLogged = key;
      console.log(`[bot] ${key}`);
    }
  };
  const deadline = Date.now() + 600000; // 最多 10 分钟
  while (Date.now() < deadline) {
    const st = byId.T.last;
    logPhase();
    if (st.phase === 'GAME_OVER') break;

    if (st.phase === 'DOMINANCE') {
      // 碾压判定命中 → 看结算
      if (byId.T.lastDominanceKey !== `${st.round.trickHistory.length}`) {
        byId.T.lastDominanceKey = `${st.round.trickHistory.length}`;
        byId.T.send({ type: 'confirmDominance' });
      }
      await sleep(30);
      continue;
    }
    if (st.phase === 'READY_CHECK') {
      // 每局开始：重置 bot 的按局标志
      byId.T.lastDominanceKey = null;
      for (const c of clients) {
        c.declared = false;
        c.buried = false;
        c.lastDrawKey = null;
        c.lastPlayKey = null;
        c.send({ type: 'ready' });
      }
      await waitUntil(() => byId.T.last.phase !== 'READY_CHECK', 8000);
      continue;
    }
    if (st.phase === 'REVEAL_FIRST') {
      if (st.flipperSeat === null) byId.T.send({ type: 'claimFlipper' });
      await waitUntil(() => byId.T.last.phase !== 'REVEAL_FIRST', 15000);
      continue;
    }
    if (st.phase === 'REVEALING') {
      rankCardByRound[st.round.roundNumber] = st.round.rankCard;
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
      await sleep(30);
      continue;
    }
    if (st.phase === 'KITTY_EXCHANGE') {
      const decl = clients.find(c => c.last?.you.seat === st.declarerSeat);
      // 等庄家自己的视角同步到 KITTY_EXCHANGE（33 张）再埋，避免用陈旧状态发牌
      const ready = decl && !decl.buried && decl.last?.phase === 'KITTY_EXCHANGE' && decl.last.you.hand.length === 33;
      if (ready) {
        decl.buried = true;
        console.log(`[bot] ${decl.id} 埋底（手牌 ${decl.last.you.hand.length} 张）`);
        decl.send({ type: 'buryKitty', cardIds: decl.last.you.hand.slice(0, 8).map(c => c.id) });
      }
      await sleep(30);
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
    if (st.phase === 'PLAYING') {
      const ctx = { trumpSuit: st.round.trumpSuit, rankCard: st.round.rankCard };
      for (const c of clients) {
        const s = c.last;
        if (!s || s.phase !== 'PLAYING') continue;
        if (s.round.lastTrick) continue;
        if (s.round.turnSeat !== s.you.seat) continue;
        const key = `${s.round.trickHistory.length}:${s.round.currentTrick.length}`;
        if (c.lastPlayKey === key) continue;
        c.lastPlayKey = key;
        const lead = s.round.currentTrick[0] ?? null;
        const cards = botCards(s.you.hand, lead, ctx);
        c.send({ type: 'play', cardIds: cards.map(x => x.id) });
      }
      await sleep(25);
      continue;
    }
    // SCORING / ROUND_END：等引擎推进
    await sleep(40);
  }

  const final = byId.T.last;
  assert(final.phase === 'GAME_OVER', '连续多局打到 GAME_OVER');
  assert(final.gameWinnerTeam !== null, '有获胜队');

  // 录像式日志：逐局打印 RoundSummary（供人工复核算分）
  console.log('\n========== 整局录像（RoundSummary 逐局）==========');
  console.log(`种子：${health.seed ?? '（未知）'}  获胜：${final.gameWinnerTeam === 0 ? '金队' : '青队'}`);
  const suitName = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const rankName = r => ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'][r - 2];
  for (const s of final.rounds) {
    const declarer = final.players.find(p => p.seat === s.declarerSeat).nickname;
    const next = final.players.find(p => p.seat === s.nextDeclarerSeat).nickname;
    const nextRank = rankCardByRound[s.roundNumber + 1];
    console.log(
      `第${String(s.roundNumber).padStart(2)}局 | 庄:${declarer} 主${suitName[s.trumpSuit]}打${rankName(s.rankCard)} ` +
      `| 闲家台面:${String(s.defenderTrickPoints).padStart(3)} 跑掉:${String(s.runAwayPoints).padStart(3)} 底牌:${String(s.kittyPoints).padStart(2)}` +
      `${s.kittyGrab ? ' 撬底+20' : ''} → P=${String(s.defenderPoints).padStart(3)} ` +
      `| ${s.transfer ? '移庄' : '连庄'} ${s.upgradeCount > 0 ? `${s.upgradedTeam === 0 ? '金队' : '青队'}+${s.upgradeCount}级` : '双方不升级'} ` +
      `| 下局庄:${next}${nextRank ? `(打${rankName(nextRank)})` : ''} 守恒:${s.conservationOk ? '✓' : '✗'}`
    );
  }
  console.log('================================================');

  console.log(`\nSMOKE OK（${passed} 项通过，共 ${final.rounds.length} 局）`);
  process.exit(0);
}

main().catch(e => {
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});