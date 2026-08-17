import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, createRoundState, playerBySeat } from '../state.js';
import { applyAction } from '../actions.js';
import { rebuildPieces } from '../pieces.js';
import { checkDominance } from '../dominance.js';
import { playSuitOf, cardStrength, sortHand } from '../cards.js';
import { settleRound } from '../scoring.js';

const seeded = () => 0.42;
const c = (id, suit, rank) => ({ id, suit, rank });

// 构造 PLAYING 状态：指定四家手牌（主牌 H、打2、庄家队0、当前领出方可指定）
function playingState(handsBySeat, { declarerSeat = 0, leadSeat = 0 } = {}) {
  const state = createInitialState(seeded);
  state.declarerSeat = declarerSeat;
  state.round = createRoundState(1, declarerSeat);
  state.round.trumpSuit = 'H';
  state.round.rankCard = 2;
  const ctx = { trumpSuit: 'H', rankCard: 2 };
  for (const [seat, cards] of Object.entries(handsBySeat)) {
    playerBySeat(state, Number(seat)).hand = sortHand(cards, ctx);
  }
  state.round.kitty = [];
  state.phase = 'PLAYING';
  state.round.leadSeat = leadSeat;
  state.round.turnSeat = leadSeat;
  state.round.currentTrick = [];
  state.round.lastTrick = null;
  rebuildPieces(state);
  return state;
}

// 占优局面：金队(0/2) 各 2 张强黑桃，青队(1/3) 各 2 张弱方块，均无主牌；金队领出
function dominantState() {
  return playingState(
    {
      0: [c('s1', 'S', 14), c('s2', 'S', 13)], // 金队 ♠A ♠K
      2: [c('s3', 'S', 12), c('s4', 'S', 11)], // 金队 ♠Q ♠J
      1: [c('d1', 'D', 5), c('d2', 'D', 4)],   // 青队 弱方块
      3: [c('d3', 'D', 3), c('d4', 'D', 6)],   // 青队 弱方块
    },
    { leadSeat: 0 } // 金队领出
  );
}

test('碾压触发：B 队无主牌、每门花色严格占优、领出方是 A 队 → 判定成立，撬底归属正确', () => {
  const state = dominantState();
  const dom = checkDominance(state);
  assert.ok(dom, '应判定碾压');
  assert.equal(dom.winningTeam, 0, '金队占优');
  assert.equal(dom.remainingTricks, 2);
  assert.equal(dom.remainingPoints, 15, '♠K=10 + ♦5=5');
  // declarerSeat=0 → 庄家队=0；金队=队0 → 金队是庄家方 → 分作废、不撬底
  assert.equal(dom.pointsToDefender, false);
  assert.equal(dom.kittyGrab, false);
});

test('碾压不触发：B 队还剩一张主牌', () => {
  const state = dominantState();
  playerBySeat(state, 1).hand.push(c('h9', 'H', 9)); // 青队多一张主牌（手牌数不再相等，但判定只看主牌）
  assert.equal(checkDominance(state), null);
});

test('碾压不触发：领出方是 B 队', () => {
  // 金队黑桃占优；青队放一张弱黑桃，使其自身不占优；此时领出方是青队 → 不触发
  const state = playingState(
    {
      0: [c('s1', 'S', 14), c('s2', 'S', 13)],
      2: [c('s3', 'S', 12), c('s4', 'S', 11)],
      1: [c('s5', 'S', 4), c('d2', 'D', 4)], // 青队持弱黑桃 → 自身不占优
      3: [c('d3', 'D', 3), c('d4', 'D', 6)],
    },
    { leadSeat: 1 } // 青队领出
  );
  assert.equal(checkDominance(state), null);
});

test('碾压不触发：A 队某花色最小牌等于（非大于）B 队该花色最大牌', () => {
  // 金队只有黑桃、青队只有方块 → A 不持有方块永远不会领方块 → 可触发
  const state = playingState(
    {
      0: [c('s1', 'S', 14), c('s2', 'S', 9)],  // 金队 ♠A ♠9
      2: [c('s3', 'S', 13), c('s4', 'S', 8)],  // 金队 ♠K ♠8
      1: [c('d1', 'D', 9), c('d2', 'D', 4)],   // 青队 方块（无黑桃、无主牌）
      3: [c('d3', 'D', 3), c('d4', 'D', 6)],
    },
    { leadSeat: 0 }
  );
  const dom = checkDominance(state);
  assert.ok(dom, 'A 不持有的花色无需比较 → 成立');
  assert.equal(dom.winningTeam, 0);
  // 构造严格等于的情形：金队最小方块 9 = 青队最大方块 9
  const state2 = playingState(
    {
      0: [c('s1', 'S', 14), c('d9', 'D', 9)],
      2: [c('s3', 'S', 13), c('d8', 'D', 8)],
      1: [c('d1', 'D', 9), c('d2', 'D', 4)],
      3: [c('d3', 'D', 3), c('d4', 'D', 6)],
    },
    { leadSeat: 0 }
  );
  assert.equal(checkDominance(state2), null, '最小牌等于对方最大牌 → 不成立（必须严格大于）');
});

test('碾压确认：剩余分全部判给 A 队、最后一轮赢家记为 A 队、撬底公式正确', () => {
  // 金队(闲家方，庄家=1队)剩余分牌：♠K=10、♦5=5 → 共 15 分
  const state = playingState(
    {
      0: [c('s1', 'S', 14), c('s2', 'S', 13)],
      2: [c('s3', 'S', 12), c('s4', 'S', 11)],
      1: [c('d1', 'D', 5), c('d2', 'D', 4)],
      3: [c('d3', 'D', 3), c('d4', 'D', 6)],
    },
    { declarerSeat: 1, leadSeat: 0 } // 庄家=青队(1)，金队(0)是闲家方
  );
  const dom = checkDominance(state);
  assert.ok(dom);
  assert.equal(dom.pointsToDefender, true, '金队是闲家方');
  assert.equal(dom.remainingPoints, 15, '♠K=10 + ♦5=5');
  state.round.kitty = [{ id: 'k1', suit: 'S', rank: 5 }]; // 底牌 5 分
  // 真实流程中由 handlePlay/buryKitty 命中碾压后置为 DOMINANCE
  state.round.dominance = dom;
  state.phase = 'DOMINANCE';
  const res = applyAction(state, { type: 'confirmDominance' }, 'T');
  assert.equal(res.ok, true);
  assert.equal(state.phase, 'SCORING', '确认后照常走结算');
  const summary = state.rounds[0];
  assert.equal(summary.defenderTrickPoints, 15, '剩余 15 分计入闲家（金队）');
  assert.equal(summary.kittyGrab, true, '最后一轮赢家是金队（闲家方）→ 撬底');
  assert.equal(summary.defenderPoints, 15 + 5 + 20, 'P = 台面15 + 底牌5 + 20 = 40');
  assert.equal(summary.transfer, true, '撬底无条件移庄');
  assert.equal(summary.upgradeCount, 0, 'P_final<80 → 双方不升级');
});

test('对拍：碾压结算结果 与 bot 老老实实打完剩余轮次 完全一致', () => {
  // 构造真实尺寸：每家 3 张（金队强黑桃含分牌，青队弱牌无主牌），金队领出
  const build = () =>
    playingState(
      {
        0: [c('a1', 'S', 14), c('a2', 'S', 13), c('a3', 'S', 10)], // ♠A ♠K ♠10(10分)
        2: [c('a4', 'S', 12), c('a5', 'S', 11), c('a6', 'S', 9)],  // ♠Q ♠J ♠9
        1: [c('b1', 'D', 6), c('b2', 'D', 5), c('b3', 'D', 4)],    // ♦6 ♦5(5分) ♦4
        3: [c('b4', 'D', 3), c('b5', 'D', 7), c('b6', 'D', 8)],    // ♦3 ♦7 ♦8
      },
      { declarerSeat: 1, leadSeat: 0 } // 庄家=青队；金队=闲家方
    );

  // 分支A：碾压确认
  const stateA = build();
  stateA.round.kitty = [{ id: 'k1', suit: 'S', rank: 5 }, { id: 'k2', suit: 'D', rank: 10 }];
  const dom = checkDominance(stateA);
  assert.ok(dom, '判定成立');
  assert.equal(dom.remainingPoints, 25, '♠K=10 + ♠10=10 + ♦5=5 = 25');
  stateA.round.dominance = dom;
  stateA.phase = 'DOMINANCE';
  applyAction(stateA, { type: 'confirmDominance' }, 'T');
  const summaryA = stateA.rounds[0];

  // 分支B：bot 逐轮打完（金队每次领出最小黑桃，青队无法跟黑桃只能垫）
  const stateB = build();
  stateB.round.kitty = [{ id: 'k1', suit: 'S', rank: 5 }, { id: 'k2', suit: 'D', rank: 10 }];
  const ctx = { trumpSuit: 'H', rankCard: 2 };
  const suitOf = x => playSuitOf(x, ctx.trumpSuit, ctx.rankCard);
  const lowest = (cards, n) =>
    [...cards].sort((a, b) => cardStrength(a, ctx) - cardStrength(b, ctx)).slice(0, n);
  for (let trick = 0; trick < 3; trick++) {
    stateB.round.lastTrick = null;
    for (let i = 0; i < 4; i++) {
      const p = playerBySeat(stateB, stateB.round.turnSeat);
      const lead = stateB.round.currentTrick[0] ?? null;
      let cards;
      if (!lead) {
        const nonTrump = p.hand.filter(x => suitOf(x) !== 'TRUMP');
        cards = [lowest(nonTrump.length ? nonTrump : p.hand, 1)[0]];
      } else {
        const suitCards = p.hand.filter(x => suitOf(x) === lead.playSuit);
        const N = lead.cards.length;
        cards =
          suitCards.length >= N
            ? lowest(suitCards, N)
            : [...lowest(suitCards, suitCards.length), ...lowest(p.hand.filter(x => !suitCards.includes(x)), N - suitCards.length)];
      }
      const res = applyAction(stateB, { type: 'play', cardIds: cards.map(x => x.id) }, p.id);
      assert.equal(res.ok, true, `对拍分支 bot 出牌失败：${res.error?.reason}`);
    }
  }
  assert.equal(stateB.phase, 'SCORING');
  const summaryB = stateB.rounds[0];

  // 两分支结算必须完全一致
  for (const key of [
    'defenderTrickPoints',
    'runAwayPoints',
    'kittyPoints',
    'kittyGrab',
    'defenderPoints',
    'transfer',
    'upgradedTeam',
    'upgradeCount',
    'nextDeclarerSeat',
  ]) {
    assert.equal(summaryA[key], summaryB[key], `对拍字段 ${key} 不一致`);
  }
});

test('碾压不触发：条件未齐时照常出牌（checkDominance 返回 null 不干扰流程）', () => {
  const state = dominantState();
  state.round.leadSeat = 1; // 领出方是 B → 不触发
  state.round.turnSeat = 1;
  const res = applyAction(
    state,
    { type: 'play', cardIds: [playerBySeat(state, 1).hand[0].id] },
    state.players.find(p => p.seat === 1).id
  );
  assert.equal(res.ok, true);
  assert.equal(state.phase, 'PLAYING', '照常出牌');
});

test('settleRound 对拍基线：确认对拍用的期望公式一致', () => {
  const r = settleRound({ defenderTrickPoints: 15, kittyPoints: 15, kittyGrab: true, declarerTeam: 1 });
  assert.equal(r.defenderPoints, 15 + 15 + 20);
  assert.equal(r.transfer, true);
});
