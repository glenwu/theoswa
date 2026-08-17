import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, createRoundState, playerBySeat } from '../state.js';
import { buildDeck, separateKitty } from '../cards.js';
import { drawOneCard } from '../round.js';
import { fallbackTrumpOf } from '../reveal.js';
import { GameEngine } from '../game-engine.js';

const seeded = () => 0.42;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 构造揭牌阶段状态（真实牌组，庄家可选）
function revealingState({ declarerSeat = null } = {}) {
  const state = createInitialState(seeded);
  const deck = buildDeck();
  const kitty = separateKitty(deck);
  state.declarerSeat = declarerSeat;
  state.round = createRoundState(1, declarerSeat);
  state.round.rankCard = 2;
  state.round.kitty = kitty;
  state.round.deck = deck;
  state.round.revealTurnSeat = 0;
  state.phase = 'REVEALING';
  return state;
}

test('揭牌超时：服务端自动替当前揭牌人摸牌并逆时针轮转（任何人挂机不卡全场）', async () => {
  const state = revealingState();
  const engine = new GameEngine({ state, timings: { drawMs: 40 }, broadcast: () => {} });
  await sleep(220);
  const drawn = state.round.drawnCount;
  assert.ok(drawn >= 1, '超时自动摸牌');
  assert.equal(state.round.revealTurnSeat, (0 + 3 * drawn) % 4, '轮转顺序逆时针');
  assert.equal(playerBySeat(state, 0).hand.length, Math.ceil(drawn / 4));
  engine.clearTimers();
});

test('亮主不受揭牌回合限制：轮到别人揭牌时也能亮（携带 cardId）', async () => {
  const state = revealingState();
  // 正常揭牌直到有人摸到级牌
  let two = null;
  let holderId = null;
  while (!two && state.round.deck.length > 0) {
    const seat = state.round.revealTurnSeat;
    const card = drawOneCard(state, seat);
    if (card.rank === 2) {
      two = card;
      holderId = state.players.find(p => p.seat === seat).id;
    }
  }
  assert.ok(two, '有人摸到级牌');
  const holderSeat = state.seatsByPlayer[holderId];
  assert.notEqual(holderSeat, state.round.revealTurnSeat, '现在轮到别人揭牌');

  const engine = new GameEngine({ state, timings: { dealingMs: 30 }, broadcast: () => {} });
  const res = engine.applyAction({ type: 'declareTrump', cardId: two.id }, holderId);
  assert.equal(res.ok, true);
  assert.equal(state.round.trumpSuit, two.suit);
  assert.equal(state.phase, 'DEALING');
  await sleep(120);
  assert.equal(state.phase, 'KITTY_EXCHANGE');
  // 不变量：庄家 33 张（底牌已并入），其余三家各 25 张，牌堆清空
  for (const p of state.players) {
    assert.equal(p.hand.length, p.seat === state.declarerSeat ? 33 : 25);
  }
  assert.equal(state.round.deck.length, 0);
  assert.equal(state.round.kitty.length, 0, '换底前底牌已并进庄家手牌');
  engine.clearTimers();
});

test('宽限窗口截止前亮主成功', async () => {
  const state = revealingState();
  while (state.round.deck.length > 0) drawOneCard(state, state.round.revealTurnSeat);
  assert.equal(state.round.drawnCount, 100);
  // 从别人手里拿一张 2 给 T（T 手里捏着未亮的级牌）
  const tSeat = state.seatsByPlayer.T;
  let two = null;
  for (const p of state.players) {
    const c = p.hand.find(c => c.rank === 2);
    if (c && p.seat !== tSeat) {
      two = c;
      p.hand = p.hand.filter(x => x !== c);
      break;
    }
  }
  assert.ok(two, '100 张里必有级牌（除非全在底牌）');
  playerBySeat(state, tSeat).hand.push(two);

  const engine = new GameEngine({ state, timings: { graceMs: 300 }, broadcast: () => {} });
  await sleep(120); // 截止前
  const res = engine.applyAction({ type: 'declareTrump', cardId: two.id }, 'T');
  assert.equal(res.ok, true, '宽限窗口内仍可亮主');
  assert.equal(state.round.trumpSuit, two.suit);
  engine.clearTimers();
});

test('宽限窗口结束后（庄家未定）：流局回 READY_CHECK，级别局数不变，再亮主被拒（实机可达性）', async () => {
  const state = revealingState();
  while (state.round.deck.length > 0) drawOneCard(state, state.round.revealTurnSeat);
  const engine = new GameEngine({ state, timings: { graceMs: 120 }, broadcast: () => {} });
  await sleep(350); // 截止后
  assert.equal(state.phase, 'READY_CHECK');
  assert.equal(state.declarerSeat, null);
  assert.equal(state.round.roundNumber, 1, '流局不递增局数');
  assert.deepEqual(state.teamLevels, [0, 0], '级别不变');
  assert.ok(state.players.every(p => p.hand.length === 0), '不发牌');
  const res = engine.applyAction({ type: 'declareTrump', cardId: 'any' }, 'T');
  assert.equal(res.error.code, 'WRONG_PHASE', '宽限结束后亮主被拒');
  engine.clearTimers();
});

test('宽限窗口结束后（庄家已定）：揭底定主 → 自动发完 → 进入换底（庄家不变）', async () => {
  const state = revealingState({ declarerSeat: 2 });
  while (state.round.deck.length > 0) drawOneCard(state, state.round.revealTurnSeat);
  const expected = fallbackTrumpOf(state.round.kitty, 2).trumpSuit;
  const engine = new GameEngine({
    state,
    timings: { graceMs: 80, fallbackMs: 20, dealingMs: 20 },
    broadcast: () => {},
  });
  await sleep(700);
  assert.equal(state.phase, 'KITTY_EXCHANGE');
  assert.equal(state.round.trumpSuit, expected);
  assert.equal(state.round.fallbackRevealed.length, 8, '底牌全部公开摊开');
  assert.equal(state.declarerSeat, 2, '庄家不变');
  for (const p of state.players) {
    assert.equal(p.hand.length, p.seat === state.declarerSeat ? 33 : 25);
  }
  engine.clearTimers();
});

test('收牌停留 1.5 秒由服务端计时：停留结束后清空 lastTrick（四端同步）', async () => {
  const state = createInitialState(seeded);
  state.round = createRoundState(1, 0);
  state.round.trumpSuit = 'H';
  state.phase = 'PLAYING';
  state.round.lastTrick = { trickNo: 1, plays: [], winnerSeat: 0, points: 0 };
  state.round.settleDeadline = Date.now() + 120;
  const engine = new GameEngine({ state, timings: { settleMs: 120 }, broadcast: () => {} });
  await sleep(50);
  assert.ok(state.round.lastTrick !== null, '停留期间保持展示');
  await sleep(200);
  assert.equal(state.round.lastTrick, null, '服务端计时结束清空');
  engine.clearTimers();
});

test('出牌超时：服务端自动打出最小合法牌并轮转（不判负、不跳过）', async () => {
  const state = createInitialState(seeded);
  state.declarerSeat = 0;
  state.round = createRoundState(1, 0);
  state.round.trumpSuit = 'H';
  state.round.rankCard = 2;
  playerBySeat(state, 0).hand = [{ id: 'a1', suit: 'S', rank: 3 }, { id: 'a2', suit: 'S', rank: 5 }];
  playerBySeat(state, 3).hand = [{ id: 'b1', suit: 'S', rank: 7 }, { id: 'b2', suit: 'S', rank: 9 }];
  playerBySeat(state, 2).hand = [{ id: 'c1', suit: 'S', rank: 4 }, { id: 'c2', suit: 'S', rank: 6 }];
  playerBySeat(state, 1).hand = [{ id: 'd1', suit: 'S', rank: 8 }, { id: 'd2', suit: 'S', rank: 10 }];
  state.round.kitty = [];
  state.phase = 'PLAYING';
  state.round.leadSeat = 0;
  state.round.turnSeat = 0;
  state.round.currentTrick = [];
  state.round.lastTrick = null;
  const engine = new GameEngine({ state, timings: { playMs: 80 }, broadcast: () => {} });
  await sleep(110); // 一次超时：首家自动打出最小单张 ♠3
  assert.equal(playerBySeat(state, 0).hand.length, 1, '自动打出一张（最小单张）');
  assert.equal(state.round.currentTrick[0].cards[0].id, 'a1', '自动打出的是最小牌');
  assert.equal(state.round.turnSeat, 3, '轮转到下家');
  assert.ok(state.log.some(l => l.text.includes('出牌超时，自动打出')));
  engine.clearTimers();
});
