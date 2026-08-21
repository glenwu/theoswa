import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, createRoundState, playerBySeat } from '../state.js';
import { applyAction, ErrorCode } from '../actions.js';
import { buildDeck, separateKitty, sortHand, cardPoints, playSuitOf, cardStrength } from '../cards.js';
import { rebuildPieces } from '../pieces.js';
import { nextSeat } from '../rotation.js';

const seeded = () => 0.42;
const c = (id, suit, rank) => ({ id, suit, rank });

// 构造 PLAYING 状态（指定四家手牌与底牌）
function playingState(handsBySeat, { trumpSuit = 'H', rankCard = 2, declarerSeat = 0, kitty } = {}) {
  const state = createInitialState(seeded);
  state.declarerSeat = declarerSeat;
  state.round = createRoundState(1, declarerSeat);
  state.round.trumpSuit = trumpSuit;
  state.round.rankCard = rankCard;
  const ctx = { trumpSuit, rankCard };
  for (const [seat, cards] of Object.entries(handsBySeat)) {
    playerBySeat(state, Number(seat)).hand = sortHand(cards, ctx);
  }
  state.round.kitty = kitty ?? [];
  state.phase = 'PLAYING';
  state.round.leadSeat = declarerSeat;
  state.round.turnSeat = declarerSeat;
  rebuildPieces(state);
  return state;
}

// 简单 bot：合法出牌（首家出最小非主牌；跟牌按规则）
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
  if (trumps.length >= N) return lowest(trumps, N); // 杀
  return lowest(hand, N); // 垫
}

function playTrick(state, ctx) {
  state.round.lastTrick = null; // 模拟引擎收牌停留结束
  for (let i = 0; i < 4; i++) {
    const p = playerBySeat(state, state.round.turnSeat);
    const lead = state.round.currentTrick[0] ?? null;
    const cards = botCards(p.hand, lead, ctx);
    const res = applyAction(state, { type: 'play', cardIds: cards.map(x => x.id) }, p.id);
    assert.equal(res.ok, true, `bot 出牌失败：${res.error?.reason}`);
  }
}

test('出牌顺序：未轮到你 → NOT_YOUR_TURN；轮到者正常出牌；结算停留中 → WAIT_SETTLE', () => {
  const state = playingState({
    0: [c('t1', 'H', 14)],
    3: [c('k1', 'S', 13)],
    2: [c('x1', 'S', 10)],
    1: [c('d1', 'D', 9)],
  });
  const actor0 = state.players.find(p => p.seat === 0).id;
  const wrong = state.players.find(p => p.seat !== 0).id;
  assert.equal(applyAction(state, { type: 'play', cardIds: ['k1'] }, wrong).error.code, ErrorCode.NOT_YOUR_TURN);
  assert.equal(applyAction(state, { type: 'play', cardIds: ['t1'] }, actor0).ok, true, '轮到者正常出牌');
  assert.equal(state.round.currentTrick.length, 1);
  // 结算停留期间拒绝出牌
  state.round.currentTrick = [];
  state.round.lastTrick = { trickNo: 1, plays: [], winnerSeat: 0, points: 0 };
  assert.equal(applyAction(state, { type: 'play', cardIds: ['t1'] }, actor0).error.code, ErrorCode.WAIT_SETTLE);
});

test('验收18：庄家方赢下含 K+10 的一轮 → 闲家得分不变，20 分直接作废', () => {
  // 座位0庄家(队0) 先出 ♥A（主牌）；闲家们垫 ♠K ♠10 ♦9
  const state = playingState({
    0: [c('t1', 'H', 14)],
    3: [c('k1', 'S', 13)], // 下家 队1
    2: [c('x1', 'S', 10)], // 对家 队0
    1: [c('d1', 'D', 9)],  // 上家 队1
  });
  const ctx = { trumpSuit: 'H', rankCard: 2 };
  playTrick(state, ctx);
  assert.equal(state.round.lastTrick.winnerSeat, 0);
  assert.equal(state.round.lastTrick.points, 20);
  assert.equal(state.round.defenderTrickPoints, 0, '闲家得分不变');
  assert.equal(state.round.runAwayPoints, 20, '庄家赢的分作废跑掉，不归任何一方');
  assert.equal(state.phase, 'SCORING', '手牌打完进入结算');
});

test('闲家方赢下的一轮 → 分数计入闲家', () => {
  const state = playingState({
    0: [c('s1', 'S', 3)],
    3: [c('s2', 'S', 13)], // ♠K：下家(队1)赢
    2: [c('s3', 'S', 4)],
    1: [c('s4', 'S', 7)],
  });
  playTrick(state, { trumpSuit: 'H', rankCard: 2 });
  assert.equal(state.round.lastTrick.winnerSeat, 3);
  assert.equal(state.round.defenderTrickPoints, 10);
  assert.equal(state.round.runAwayPoints, 0);
});

test('甩牌集成：资格不成立服务端拒绝；资格成立正常出（其余三家按张数跟）', () => {
  // 黑桃件全在别人家（unseen）→ 甩黑桃被拒
  const state = playingState({
    0: [c('s1', 'S', 9), c('s2', 'S', 8), c('h1', 'H', 3)],
    3: [c('s3', 'S', 14), c('s4', 'S', 14), c('s5', 'S', 13)],
    2: [c('s6', 'S', 13), c('h2', 'H', 4), c('h3', 'H', 5)],
    1: [c('s7', 'S', 7), c('s8', 'S', 6), c('s9', 'S', 5)],
  });
  const actor0 = state.players.find(p => p.seat === 0).id;
  const r = applyAction(state, { type: 'play', cardIds: ['s1', 's2'] }, actor0);
  assert.equal(r.error.code, 'THROW_NOT_ELIGIBLE');
  assert.match(r.error.reason, /甩牌不成立，还差 ♠A、♠A、♠K、♠K/);
  assert.equal(playerBySeat(state, 0).hand.length, 3, '被拒后牌未出');

  // 件全在自己手上 → 甩牌成立（四家手牌数相等：6/6/6/6）
  const state2 = playingState({
    0: [c('a1', 'S', 14), c('a2', 'S', 14), c('k1', 'S', 13), c('k2', 'S', 13), c('s1', 'S', 9), c('s2', 'S', 8)],
    3: [c('d1', 'D', 4), c('d2', 'D', 3), c('d3', 'D', 5), c('d4', 'D', 6), c('d5', 'D', 7), c('d6', 'D', 8)],
    2: [c('h1', 'H', 7), c('h2', 'H', 8), c('h3', 'H', 9), c('h4', 'H', 10), c('h5', 'H', 11), c('h6', 'H', 12)],
    1: [c('c1', 'C', 4), c('c2', 'C', 5), c('c3', 'C', 6), c('c4', 'C', 7), c('c5', 'C', 8), c('c6', 'C', 9)],
  });
  const actor = state2.players.find(p => p.seat === 0).id;
  const ok = applyAction(state2, { type: 'play', cardIds: ['s1', 's2'] }, actor);
  assert.equal(ok.ok, true, '甩 2 张黑桃成立');
  assert.equal(state2.round.currentTrick[0].cards.length, 2);
  // 三家各跟 2 张（无黑桃 → 垫/杀均可）
  for (let i = 0; i < 3; i++) {
    const p = playerBySeat(state2, state2.round.turnSeat);
    const lead = state2.round.currentTrick[0];
    const cards = botCards(p.hand, lead, { trumpSuit: 'H', rankCard: 2 });
    assert.equal(applyAction(state2, { type: 'play', cardIds: cards.map(x => x.id) }, p.id).ok, true);
  }
  assert.ok(state2.round.lastTrick, '甩牌轮结算完成');
  assert.equal(playerBySeat(state2, 0).hand.length, 4, '甩牌者留牌 4 张');
});

test('件迁移集成：本轮打出的件 → piecesView 显示已打出（seen）', () => {
  const state = playingState({
    0: [c('a1', 'S', 14)],   // ♠A（件）
    3: [c('k1', 'S', 13)],   // ♠K（件）
    2: [c('s1', 'S', 10)],
    1: [c('s2', 'S', 9)],
  }, { trumpSuit: 'H', rankCard: 2 });
  playTrick(state, { trumpSuit: 'H', rankCard: 2 });
  assert.equal(state.round.lastTrick.winnerSeat, 0, '♠A 最大');
  const played = state.round.pieces.filter(p => p.location.kind === 'played');
  assert.equal(played.length, 2, '本轮打出的两件标记为已打出');
});

test('全场守恒（验收8/19）：25 轮打完，闲家分 + 庄家跑掉分 + 底牌分 = 200', () => {
  const state = createInitialState(seeded);
  state.declarerSeat = 0;
  state.round = createRoundState(1, 0);
  state.round.trumpSuit = 'H';
  state.round.rankCard = 2;
  const deck = buildDeck();
  const kitty = separateKitty(deck);
  let seat = 0;
  while (deck.length > 0) {
    playerBySeat(state, seat).hand.push(deck.pop());
    seat = nextSeat(seat);
  }
  const ctx = { trumpSuit: 'H', rankCard: 2 };
  for (const p of state.players) p.hand = sortHand(p.hand, ctx);
  state.round.kitty = kitty;
  state.phase = 'PLAYING';
  state.round.leadSeat = 0;
  state.round.turnSeat = 0;
  rebuildPieces(state);

  let guard = 0;
  while (guard++ < 200) {
    if (state.phase === 'DOMINANCE') {
      // 碾压判定命中 → 确认并进入结算
      const res = applyAction(state, { type: 'confirmDominance' }, 'T');
      assert.equal(res.ok, true);
      break;
    }
    if (state.phase !== 'PLAYING') break;
    playTrick(state, ctx);
    assert.equal(new Set(state.players.map(p => p.hand.length)).size, 1, '每轮后四家手牌数相等');
  }
  assert.equal(state.phase, 'SCORING');
  // 有碾压时存在虚拟最后一轮，总条目 <25；否则正好 25 轮
  assert.ok(
    state.round.trickHistory.length === 25 || state.round.trickHistory.some(t => t.virtual),
    '轮次完整（或由碾压虚拟收尾）'
  );
  assert.equal(state.round.currentTrick.length, 0);
  const kittyPoints = state.round.kitty.reduce((s, x) => s + cardPoints(x), 0);
  assert.equal(
    state.round.defenderTrickPoints + state.round.runAwayPoints + kittyPoints,
    200,
    '闲家台面分 + 庄家跑掉分 + 底牌分 = 200'
  );
  // 所有件都已被打出或埋底：没有 unseen
  assert.ok(state.round.pieces.every(p => p.location.kind !== 'hand'));
});

// ---- 「谱掉你」彩蛋（打出大鬼，非最后一轮，80%）----

function eggState(handBySeat, { rng = () => 0 } = {}) {
  const state = createInitialState(() => 0.5);
  state.declarerSeat = 0;
  state.phase = 'PLAYING';
  const r = createRoundState(1, 0);
  r.trumpSuit = 'H';
  r.rankCard = 2;
  r.kitty = [];
  r.leadSeat = 0;
  r.turnSeat = 0;
  state.round = r;
  state.niiRandom = rng; // 掷骰用独立随机源，不碰发牌 rng
  for (const [seat, cards] of Object.entries(handBySeat)) {
    playerBySeat(state, Number(seat)).hand = cards;
  }
  rebuildPieces(state);
  return state;
}

const BIG = () => ({ id: 'big', suit: 'JOKER', rank: 16 });

test('打出大鬼且非最后一轮 → 触发「谱掉你」（掷骰命中时）', () => {
  const state = eggState({
    0: [BIG(), { id: 'a', suit: 'S', rank: 3 }],
    1: [{ id: 'b1', suit: 'S', rank: 4 }, { id: 'b2', suit: 'S', rank: 5 }],
    2: [{ id: 'c1', suit: 'S', rank: 6 }, { id: 'c2', suit: 'S', rank: 7 }],
    3: [{ id: 'd1', suit: 'S', rank: 8 }, { id: 'd2', suit: 'S', rank: 9 }],
  }, { rng: () => 0.1 }); // 0.1 < 0.8 → 命中
  const me = playerBySeat(state, 0);
  assert.equal(applyAction(state, { type: 'play', cardIds: ['big'] }, me.id).ok, true);
  assert.equal(state.round.currentTrick[0].pudiao, true);
});

test('掷骰未命中（≥0.8）→ 不触发', () => {
  const state = eggState({
    0: [BIG(), { id: 'a', suit: 'S', rank: 3 }],
    1: [{ id: 'b1', suit: 'S', rank: 4 }, { id: 'b2', suit: 'S', rank: 5 }],
    2: [{ id: 'c1', suit: 'S', rank: 6 }, { id: 'c2', suit: 'S', rank: 7 }],
    3: [{ id: 'd1', suit: 'S', rank: 8 }, { id: 'd2', suit: 'S', rank: 9 }],
  }, { rng: () => 0.85 });
  applyAction(state, { type: 'play', cardIds: ['big'] }, playerBySeat(state, 0).id);
  assert.equal(state.round.currentTrick[0].pudiao, undefined);
});

test('最后一轮打大鬼 → 绝不触发（哪怕掷骰必中）', () => {
  const state = eggState({
    0: [BIG()],
    1: [{ id: 'b1', suit: 'S', rank: 4 }],
    2: [{ id: 'c1', suit: 'S', rank: 6 }],
    3: [{ id: 'd1', suit: 'S', rank: 8 }],
  }, { rng: () => 0 });
  applyAction(state, { type: 'play', cardIds: ['big'] }, playerBySeat(state, 0).id);
  assert.equal(state.round.currentTrick[0].pudiao, undefined, '最后一轮没得选，不甩狠话');
});

test('打小鬼不触发（只认大鬼）', () => {
  const state = eggState({
    0: [{ id: 'small', suit: 'JOKER', rank: 15 }, { id: 'a', suit: 'S', rank: 3 }],
    1: [{ id: 'b1', suit: 'S', rank: 4 }, { id: 'b2', suit: 'S', rank: 5 }],
    2: [{ id: 'c1', suit: 'S', rank: 6 }, { id: 'c2', suit: 'S', rank: 7 }],
    3: [{ id: 'd1', suit: 'S', rank: 8 }, { id: 'd2', suit: 'S', rank: 9 }],
  }, { rng: () => 0 });
  applyAction(state, { type: 'play', cardIds: ['small'] }, playerBySeat(state, 0).id);
  assert.equal(state.round.currentTrick[0].pudiao, undefined);
});
