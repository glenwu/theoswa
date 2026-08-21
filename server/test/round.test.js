import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, createRoundState, playerBySeat } from '../state.js';
import { applyAction, ErrorCode, expireCrossRiverDecision } from '../actions.js';
import { beginRound, drawOneCard, flipCardForRevealFirst, completeDeal } from '../round.js';
import { buildDeck, separateKitty, SUITS } from '../cards.js';
import { settleNoTrump, startRevealing } from '../flow.js';
import { settleFallbackTrump, fallbackTrumpOf } from '../reveal.js';
import { rebuildPieces } from '../pieces.js';
import { viewerState } from '../viewer.js';
import { nextSeat } from '../rotation.js';

const seeded = () => 0.42;

function joinedState() {
  const state = createInitialState(seeded);
  for (const p of state.players) applyAction(state, { type: 'join' }, p.id);
  return state;
}

// 牌守恒：所有牌（各家手牌 + 底牌 + 牌堆 + 公开翻牌）id 互不重复且总数正确。
// fallbackRevealed 是底牌的公开视图（同一批牌），不单独计数，避免重复。
function allCardIds(state) {
  const ids = [];
  for (const p of state.players) for (const c of p.hand) ids.push(c.id);
  for (const c of state.round.kitty) ids.push(c.id);
  for (const c of state.round.deck) ids.push(c.id);
  for (const c of state.round.flipShown) ids.push(c.id);
  return ids;
}
function assertConservation(state, total = 108) {
  const ids = allCardIds(state);
  assert.equal(ids.length, total, '牌总数守恒');
  assert.equal(new Set(ids).size, total, 'id 互不重复');
}

// 构造换底阶段（绕过揭牌，专注换底/件校验）：主红桃打2。
// 底牌已并进庄家手牌（33 张统一排序），其中含 ♠A ♠K（件）与 ♥A（主花色A，不是件）。
function buildExchangeState() {
  const state = joinedState();
  const declarerSeat = state.seatsByPlayer.T;
  state.declarerSeat = declarerSeat;
  state.round = createRoundState(1, declarerSeat);
  state.round.trumpSuit = 'H';
  state.round.rankCard = 2;
  state.round.kitty = []; // 换底前底牌已并入庄家手牌
  const kittyCards = [
    { id: 'k1', suit: 'S', rank: 14 }, // ♠A 件
    { id: 'k2', suit: 'S', rank: 13 }, // ♠K 件
    { id: 'k3', suit: 'H', rank: 14 }, // ♥A 主花色 A：不是件，不公开
    { id: 'k4', suit: 'JOKER', rank: 16 },
    { id: 'k5', suit: 'C', rank: 5 },
    { id: 'k6', suit: 'C', rank: 10 },
    { id: 'k7', suit: 'H', rank: 7 },
    { id: 'k8', suit: 'D', rank: 3 },
  ];
  const handCards = Array.from({ length: 25 }, (_, i) => ({
    id: `h${i}`,
    suit: SUITS[i % 4],
    rank: 3 + (i % 10), // 3..12，避开 A/K，不构成件
  }));
  playerBySeat(state, declarerSeat).hand = [...handCards, ...kittyCards]; // 33 张
  state.phase = 'KITTY_EXCHANGE';
  return state;
}

// ---- 洗牌与发牌顺序 ----

test('beginRound：庄家未定 → 108张尚未分离底牌；庄家已定 → 分离8张且庄家先揭、级牌按庄家队级别', () => {
  const s1 = joinedState();
  beginRound(s1);
  assert.equal(s1.round.deck.length, 108, '第一局翻牌前不分离底牌');
  assert.equal(s1.round.kitty.length, 0);
  assert.equal(s1.round.rankCard, 2, '双方都从 2 打起');
  assert.equal(s1.round.revealTurnSeat, null);

  const s2 = joinedState();
  s2.declarerSeat = 1;
  s2.teamLevels[1 % 2] = 5; // 打 7
  beginRound(s2);
  assert.equal(s2.round.deck.length, 100);
  assert.equal(s2.round.kitty.length, 8);
  assert.equal(s2.round.revealTurnSeat, 1, '第二局起固定由庄家先揭');
  assert.equal(s2.round.rankCard, 7);
  assertConservation(s2);
});

test('翻牌定起揭人：大小王作废重翻；点数牌定起揭人后全部放回重洗并分离底牌（验收17）', () => {
  const state = joinedState();
  for (const p of state.players) applyAction(state, { type: 'confirmSeat' }, p.id);
  for (const p of state.players) applyAction(state, { type: 'ready' }, p.id);
  assert.equal(state.phase, 'REVEAL_FIRST');
  applyAction(state, { type: 'claimFlipper' }, 'T');
  const flipperSeat = state.flipperSeat;

  // 安排牌堆：先翻出两张王，再翻出 ♣6（6%4=2 → 下家）
  const full = buildDeck();
  const s1 = full.find(c => c.suit === 'JOKER' && c.rank === 15);
  const b1 = full.find(c => c.suit === 'JOKER' && c.rank === 16);
  const point = full.find(c => c.suit === 'C' && c.rank === 6);
  const rest = full.filter(c => c !== s1 && c !== b1 && c !== point);
  state.round.deck = [...rest, point, b1, s1]; // pop 顺序：小王、大王、♣6

  const r1 = flipCardForRevealFirst(state);
  assert.equal(r1.kind, 'JOKER');
  assert.equal(state.phase, 'REVEAL_FIRST', '王作废，继续翻');
  const r2 = flipCardForRevealFirst(state);
  assert.equal(r2.kind, 'JOKER');
  assert.equal(state.round.flipShown.length, 2);
  const r3 = flipCardForRevealFirst(state);
  assert.equal(r3.kind, 'STARTER');
  assert.equal(r3.starterSeat, nextSeat(flipperSeat), '6%4=2 → 翻牌人的下家');
  // 起揭人定出后不立刻开揭：先停留供四家看清，阶段仍是 REVEAL_FIRST
  assert.equal(state.phase, 'REVEAL_FIRST', '定出起揭人后先停留，不立刻开揭');
  assert.equal(state.round.flipDone, true);
  assert.ok(state.round.flipHoldDeadline > Date.now(), '停留截止时刻已种下');
  startRevealing(state);
  assert.equal(state.phase, 'REVEALING');
  assert.equal(state.round.kitty.length, 8, '翻牌完成后才分离底牌');
  assert.equal(state.round.deck.length, 100);
  assert.equal(state.round.flipShown.length, 0, '翻出的牌全部放回重洗');
  assertConservation(state);
});

test('揭牌：只能当前回合玩家摸；逆时针轮转；不记录牌面到日志', () => {
  const state = joinedState();
  state.round = createRoundState(1, null);
  state.round.deck = buildDeck().slice(0, 10);
  state.round.revealTurnSeat = 0;
  state.phase = 'REVEALING';
  const seat0 = state.players.find(p => p.seat === 0);
  const other = state.players.find(p => p.seat !== 0);
  assert.equal(applyAction(state, { type: 'drawCard' }, other.id).error.code, ErrorCode.NOT_YOUR_DRAW_TURN);
  const res = applyAction(state, { type: 'drawCard' }, seat0.id);
  assert.equal(res.ok, true);
  assert.equal(state.round.drawnCount, 1);
  assert.equal(state.round.revealTurnSeat, 3, '下家 = 逆时针下一位');
  assert.equal(seat0.hand.length, 1);
  assert.ok(state.log.every(l => !l.text.includes(seat0.hand[0].id)), '日志不泄露牌面');
});

// ---- 亮主（携带 cardId，与揭牌回合无关）----

test('亮主：非级牌拒绝、不在手上拒绝、第一人亮定后不可反主', () => {
  const state = joinedState();
  const tSeat = state.seatsByPlayer.T;
  state.round = createRoundState(1, null);
  state.round.rankCard = 2;
  state.round.deck = [];
  state.phase = 'REVEALING';
  playerBySeat(state, tSeat).hand = [
    { id: 'x1', suit: 'S', rank: 2 },
    { id: 'x2', suit: 'H', rank: 7 },
  ];
  assert.equal(applyAction(state, { type: 'declareTrump', cardId: 'x2' }, 'T').error.code, ErrorCode.CARD_NOT_RANK_CARD);
  assert.equal(applyAction(state, { type: 'declareTrump', cardId: 'ghost' }, 'T').error.code, ErrorCode.CARDS_NOT_IN_HAND);
  assert.equal(applyAction(state, { type: 'declareTrump', cardId: 'x1' }, 'T').ok, true);
  assert.equal(state.round.trumpSuit, 'S');
  assert.equal(state.phase, 'DEALING');
  // 第一局：亮牌者即庄家
  assert.equal(state.declarerSeat, tSeat, '庄家未定时，亮主者成为庄家');
  // 反主（阶段已离开 REVEALING）
  // 反主必须拿到准确原因，而不是笼统的 WRONG_PHASE / STALE_STATE：
  // 主牌已定死、不能反主，「请重试」是错的提示（验收 §10-41）
  assert.equal(
    applyAction(state, { type: 'declareTrump', cardId: 'x1' }, 'T').error.code,
    ErrorCode.TRUMP_ALREADY_DECLARED
  );
  // 真实客户端会带上自己以为的 phase，同样要拿到准确原因而不是 STALE_STATE
  assert.equal(
    applyAction(state, { type: 'declareTrump', cardId: 'x1', phase: 'REVEALING' }, 'T').error.code,
    ErrorCode.TRUMP_ALREADY_DECLARED
  );
  // 防御路径：仍处于 REVEALING 但已定主 → TRUMP_ALREADY_DECLARED
  state.phase = 'REVEALING';
  const h = state.players.find(p => p.seat !== tSeat);
  h.hand = [{ id: 'y1', suit: 'C', rank: 2 }];
  assert.equal(applyAction(state, { type: 'declareTrump', cardId: 'y1' }, h.id).error.code, ErrorCode.TRUMP_ALREADY_DECLARED);
});

test('第二局起（庄家已定）：亮主只定花色，不改变庄家归属（验收30）', () => {
  const state = joinedState();
  state.declarerSeat = 1; // 轮转确定的庄家
  state.round = createRoundState(2, 1);
  state.round.rankCard = 2;
  state.round.deck = [];
  state.phase = 'REVEALING';
  // 闲家（座位2）揭到黑桃2并亮牌
  const defender = state.players.find(p => p.seat === 2);
  defender.hand = [{ id: 'z2', suit: 'S', rank: 2 }];
  assert.equal(applyAction(state, { type: 'declareTrump', cardId: 'z2' }, defender.id).ok, true);
  assert.equal(state.round.trumpSuit, 'S');
  assert.equal(state.declarerSeat, 1, '庄家仍是轮转确定的那位');
});

test('亮主提前停止：剩余牌一次性发完，四家各 25 张 + 底牌 8 张 = 108', () => {
  const state = joinedState();
  beginRound(state);
  state.round.kitty = separateKitty(state.round.deck); // 模拟翻牌完成后
  state.round.revealTurnSeat = 0;
  state.phase = 'REVEALING';
  for (let i = 0; i < 40; i++) drawOneCard(state, state.round.revealTurnSeat);
  // 座位1的玩家手里有级牌（从剩余牌堆取一张2）
  const idx = state.round.deck.findIndex(c => c.rank === 2);
  assert.ok(idx >= 0);
  const two = state.round.deck.splice(idx, 1)[0];
  playerBySeat(state, 1).hand.push(two);
  const actor = state.players.find(p => p.seat === 1).id;
  const res = applyAction(state, { type: 'declareTrump', cardId: two.id }, actor);
  assert.equal(res.ok, true);
  assert.equal(state.phase, 'DEALING');
  completeDeal(state);
  assert.equal(state.phase, 'KITTY_EXCHANGE');
  for (const p of state.players) {
    assert.equal(p.hand.length, p.seat === state.declarerSeat ? 33 : 25, '庄家 33 张（底牌并入），其余 25 张');
  }
  assert.equal(state.round.kitty.length, 0, '换底前底牌已并入庄家手牌');
  assert.equal(state.round.deck.length, 0);
  assertConservation(state);
});

// ---- 无人亮牌：流局 / 揭底定主 ----

test('庄家未定无人亮牌 → 流局（级别、局数、庄家均不变）', () => {
  const state = joinedState();
  beginRound(state);
  state.round.kitty = separateKitty(state.round.deck);
  state.round.revealTurnSeat = 0;
  state.phase = 'REVEALING';
  while (state.round.drawnCount < 100) drawOneCard(state, state.round.revealTurnSeat);
  assert.equal(settleNoTrump(state), 'VOID');
  assert.equal(state.phase, 'READY_CHECK');
  assert.equal(state.declarerSeat, null);
  assert.equal(state.round.roundNumber, 1);
  assert.deepEqual(state.teamLevels, [0, 0]);
  assert.ok(state.players.every(p => p.hand.length === 0));
});

test('庄家已定无人亮牌 → 揭底定主 → 发完进入换底（验收27/28路径）', () => {
  const state = joinedState();
  state.declarerSeat = 2;
  beginRound(state);
  state.phase = 'REVEALING';
  while (state.round.drawnCount < 100) drawOneCard(state, state.round.revealTurnSeat);
  assert.equal(settleNoTrump(state), 'FALLBACK');
  assert.equal(state.phase, 'FALLBACK_TRUMP');
  state.round.fallbackRevealed = [...state.round.kitty]; // 逐张摊开（节奏由引擎控制）
  const expected = fallbackTrumpOf(state.round.fallbackRevealed, state.round.rankCard).trumpSuit;
  settleFallbackTrump(state);
  assert.equal(state.phase, 'DEALING');
  assert.equal(state.round.trumpSuit, expected);
  completeDeal(state);
  assert.equal(state.phase, 'KITTY_EXCHANGE');
  for (const p of state.players) {
    assert.equal(p.hand.length, p.seat === state.declarerSeat ? 33 : 25);
  }
  assertConservation(state);
});

// ---- 换底与件公开 ----

test('换底：恰好 8 张；埋入副牌 A/K 自动公开（件追踪）；主花色 A 不公开', () => {
  const state = buildExchangeState();
  const res = applyAction(
    state,
    { type: 'buryKitty', cardIds: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'] },
    'T'
  );
  assert.equal(res.ok, true);
  // 换底后进入 CROSS_RIVER（三主过河）：本测试不关心过河，模拟引擎决定窗口结束。
  // 合成手牌可能命中碾压（此前碾压在换底处是死代码，现于过河收尾时正常判定）。
  assert.equal(state.phase, 'CROSS_RIVER');
  expireCrossRiverDecision(state);
  assert.ok(['PLAYING', 'DOMINANCE'].includes(state.phase), `换底后进入 ${state.phase}`);
  const declarer = playerBySeat(state, state.declarerSeat);
  assert.equal(declarer.hand.length, 25);
  assert.equal(state.round.kitty.length, 8);
  assert.equal(state.round.leadSeat, state.declarerSeat, '第一轮由庄家先出');
  // 件去向表：♠A ♠K 埋底公开；♥A 是主花色 A → 不是件
  const pieces = state.round.pieces;
  assert.equal(pieces.length, 2);
  assert.ok(pieces.every(p => p.suit === 'S' && p.location.kind === 'kittyRevealed'));
  assert.ok(state.log.some(l => l.text.includes('庄家埋底亮出：黑桃A')));
  assert.ok(state.log.some(l => l.text.includes('庄家埋底亮出：黑桃K')));
  assert.ok(!state.log.some(l => l.text.includes('红桃A')), '主花色 A 不公开');
  assertConservation(state, 33); // 合成状态只有 25+8 张
});

test('换底校验：非庄家拒绝、张数不足拒绝、重复 id 拒绝、牌不在手上拒绝', () => {
  const state = buildExchangeState();
  const eight = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'];
  assert.equal(applyAction(state, { type: 'buryKitty', cardIds: eight }, 'H').error.code, ErrorCode.NOT_DECLARER);
  assert.equal(applyAction(state, { type: 'buryKitty', cardIds: eight.slice(0, 7) }, 'T').error.code, ErrorCode.WRONG_COUNT);
  assert.equal(applyAction(state, { type: 'buryKitty', cardIds: [...eight.slice(0, 7), 'k1'] }, 'T').error.code, ErrorCode.WRONG_COUNT);
  assert.equal(applyAction(state, { type: 'buryKitty', cardIds: [...eight.slice(0, 7), 'nope'] }, 'T').error.code, ErrorCode.CARDS_NOT_IN_HAND);
});

test('piecesView：件状态四家一致（除 mine），且不携带 cardId', () => {
  const state = buildExchangeState();
  applyAction(state, { type: 'buryKitty', cardIds: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'] }, 'T');
  // 座位2手里还有一张 ♠A（未埋入的件 → 只有座位2自己看到 mine，别人看到 unseen）
  playerBySeat(state, 2).hand[0] = { id: 'z1', suit: 'S', rank: 14 };
  rebuildPieces(state);

  for (const p of state.players) {
    const view = viewerState(state, p.id);
    const spades = view.round.piecesView.S;
    assert.equal(spades.length, 3);
    for (const item of spades) {
      assert.deepEqual(Object.keys(item).sort(), ['rank', 'status'], '不携带 cardId');
    }
    const mineCount = spades.filter(x => x.status === 'mine').length;
    assert.equal(mineCount, p.seat === 2 ? 1 : 0, '只有持有人看到 mine');
    assert.equal(spades.filter(x => x.status === 'seen').length, 2, '埋底的两件四家都看到 seen');
    assert.equal(spades.filter(x => x.status === 'unseen').length, p.seat === 2 ? 0 : 1);
  }
  // 主牌花色（红桃）没有件视图
  const anyView = viewerState(state, 'T');
  assert.equal(anyView.round.piecesView.H, undefined);
});

// ---- 揭牌阶段手牌实时整理（接线测试）----
// 纯函数 sortHandForReveal 单独测过；这里测的是「它真的被 drawOneCard 用上了」——
// 排序函数写好却没接上，是最容易漏掉的一类 bug。

function revealingState(deckTop) {
  const state = createInitialState(() => 0.5);
  state.phase = 'REVEALING';
  state.declarerSeat = null;
  const r = createRoundState(1, null);
  r.rankCard = 2;
  r.revealTurnSeat = 0;
  // deck 是从尾部 pop 的，所以倒序放入
  r.deck = [...deckTop].reverse();
  state.round = r;
  for (const p of state.players) p.hand = [];
  return state;
}

test('揭牌：每摸一张就整理手牌（鬼最左 + 黑梅方红 + 级牌提前）', () => {
  const drawOrder = [
    { id: 'h9', suit: 'H', rank: 9 },
    { id: 'c3', suit: 'C', rank: 3 },
    { id: 'j16', suit: 'JOKER', rank: 16 },
    { id: 's2', suit: 'S', rank: 2 },
    { id: 's14', suit: 'S', rank: 14 },
  ];
  const state = revealingState(drawOrder);
  // 全部摸给座 0（每次都把轮转掰回来，只验排序）
  for (let i = 0; i < drawOrder.length; i++) {
    state.round.revealTurnSeat = 0;
    drawOneCard(state, 0);
  }
  assert.deepEqual(
    playerBySeat(state, 0).hand.map(c => c.id),
    ['j16', 's2', 's14', 'c3', 'h9'],
    '摸牌顺序是乱的，手上应已排好'
  );
});

test('揭牌：整理不改变张数，也不动别人的手牌', () => {
  const drawOrder = [
    { id: 'd5', suit: 'D', rank: 5 },
    { id: 'h7', suit: 'H', rank: 7 },
  ];
  const state = revealingState(drawOrder);
  drawOneCard(state, 0);
  drawOneCard(state, state.round.revealTurnSeat);
  assert.equal(playerBySeat(state, 0).hand.length, 1);
  assert.equal(state.round.drawnCount, 2);
  const others = state.players.filter(p => p.seat !== 0 && p.seat !== 3);
  assert.ok(others.every(p => p.hand.length === 0), '只有摸牌的人手上有牌');
});

test('发牌收尾（DEALING）不套用揭牌排序，仍按主/副重排', () => {
  const state = revealingState([]);
  state.phase = 'DEALING';
  state.declarerSeat = 0;
  const r = state.round;
  r.trumpSuit = 'H';
  r.kitty = [];
  r.revealTurnSeat = 0;
  r.deck = [
    { id: 'c9', suit: 'C', rank: 9 },
    { id: 'h5', suit: 'H', rank: 5 },
    { id: 'j16', suit: 'JOKER', rank: 16 },
    { id: 's4', suit: 'S', rank: 4 },
  ];
  completeDeal(state);
  const hand = playerBySeat(state, 0).hand;
  // 主牌（♥ + 鬼）必须排在副牌前面 —— 这是 sortHand 的口径，不是揭牌口径
  const firstSide = hand.findIndex(c => c.suit !== 'H' && c.suit !== 'JOKER');
  const lastTrump = hand.map(c => c.suit === 'H' || c.suit === 'JOKER').lastIndexOf(true);
  assert.ok(lastTrump < firstSide || firstSide === -1, '主牌组整体在副牌之前');
});
