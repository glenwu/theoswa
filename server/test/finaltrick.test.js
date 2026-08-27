import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, createRoundState, playerBySeat } from '../state.js';
import { applyAction } from '../actions.js';
import { settleFinalTrick } from '../scoring.js';
import { rebuildPieces } from '../pieces.js';
import { FINAL_TRICK_SETTLE_MS, FINAL_TRICK_HOLD_MS, TRICK_SETTLE_MS } from '../constants.js';

const seeded = () => 0.42;
const c = (id, suit, rank) => ({ id, suit, rank });

// 本局最后一墩：四家各剩一张自动打出的那一墩，决定撬底，最该看清楚。
// 原来打完立刻 finishRound，结算面板一秒不到就盖上来（Glen 反馈）。
function finalTrickState() {
  const state = createInitialState(seeded);
  state.declarerSeat = 1;
  state.round = createRoundState(1, 1);
  state.round.trumpSuit = 'H';
  state.round.rankCard = 2;
  state.round.trickHistory = [{ trickNo: 1, winnerSeat: 0, plays: [], points: 0 }];
  state.round.kitty = [c('k1', 'C', 5)];
  state.round.leadSeat = 0;
  state.round.turnSeat = 0;
  state.phase = 'PLAYING';
  const hands = { 0: c('a', 'S', 6), 3: c('b', 'S', 5), 2: c('c', 'S', 4), 1: c('d', 'S', 3) };
  for (const p of state.players) p.hand = [hands[p.seat]];
  rebuildPieces(state);
  return state;
}

function playFinalTrick(state) {
  for (let i = 0; i < 4; i++) {
    const p = playerBySeat(state, state.round.turnSeat);
    const res = applyAction(state, { type: 'play', cardIds: [p.hand[0].id] }, p.id);
    assert.equal(res.ok, true, res.error?.reason);
  }
}

test('最后一墩：停留时间单独一档，明显长于普通收牌停留', () => {
  assert.ok(
    FINAL_TRICK_SETTLE_MS >= 5000,
    `Glen 要求「至少停 5 秒」，实际 ${FINAL_TRICK_SETTLE_MS}ms`
  );
  assert.ok(FINAL_TRICK_SETTLE_MS > TRICK_SETTLE_MS, '必须比普通墩的收牌停留长');
});

test('最后一墩：打完【不】立刻结算，先停着给人看', () => {
  const state = finalTrickState();
  playFinalTrick(state);
  assert.equal(state.phase, 'PLAYING', '不能当场跳去结算，那样牌面一秒不到就被盖住');
  assert.equal(state.round.finalTrickPending, true);
  assert.ok(state.round.lastTrick, '这一墩的牌面留着');
  assert.ok(
    state.round.settleDeadline - Date.now() > TRICK_SETTLE_MS,
    '停留时间要按最后一墩那一档算，不是普通的 1.5 秒'
  );
});

test('最后一墩：没人按「再看一会」→ 到点收尾结算', () => {
  const state = finalTrickState();
  playFinalTrick(state);
  assert.equal(settleFinalTrick(state), true);
  assert.equal(state.phase, 'SCORING');
});

test('最后一墩：有人按住 → 停留延到 60 秒', () => {
  const state = finalTrickState();
  playFinalTrick(state);
  const before = state.round.settleDeadline;
  const me = playerBySeat(state, 2);
  assert.equal(applyAction(state, { type: 'holdLastTrick' }, me.id).ok, true);
  assert.deepEqual(state.round.lastTrickHolds, [2]);
  assert.ok(
    state.round.settleDeadline - before > FINAL_TRICK_HOLD_MS - FINAL_TRICK_SETTLE_MS - 1000,
    '按住之后窗口要拉到 60 秒那一档'
  );
});

// ⚠️ 第二个人再按【不能】再续期一次，否则四个人轮流按就能无限拖住全场。
test('最后一墩：第二个人再按住，不再续期', () => {
  const state = finalTrickState();
  playFinalTrick(state);
  applyAction(state, { type: 'holdLastTrick' }, playerBySeat(state, 2).id);
  const after1 = state.round.settleDeadline;
  applyAction(state, { type: 'holdLastTrick' }, playerBySeat(state, 0).id);
  assert.deepEqual(state.round.lastTrickHolds, [2, 0]);
  assert.ok(state.round.settleDeadline <= after1, '第二个人不该把窗口再往后推');
});

test('最后一墩：按住的人都按了「继续」→ 立刻收尾', () => {
  const state = finalTrickState();
  playFinalTrick(state);
  const a = playerBySeat(state, 2), b = playerBySeat(state, 0);
  applyAction(state, { type: 'holdLastTrick' }, a.id);
  applyAction(state, { type: 'holdLastTrick' }, b.id);
  assert.equal(applyAction(state, { type: 'releaseLastTrick' }, a.id).ok, true);
  assert.ok(state.round.settleDeadline - Date.now() > 1000, '还有一个人按着，不能收');
  assert.equal(applyAction(state, { type: 'releaseLastTrick' }, b.id).ok, true);
  assert.ok(state.round.settleDeadline <= Date.now(), '都放开了 → 置成已到点，引擎立刻收');
});

test('最后一墩：没按住的人按「继续」→ 拒绝，不影响别人', () => {
  const state = finalTrickState();
  playFinalTrick(state);
  applyAction(state, { type: 'holdLastTrick' }, playerBySeat(state, 2).id);
  const res = applyAction(state, { type: 'releaseLastTrick' }, playerBySeat(state, 0).id);
  assert.equal(res.ok, false);
  assert.deepEqual(state.round.lastTrickHolds, [2], '按住的人没被清掉');
});

// 普通墩不给按钮：每墩都弹一个出来只会碍事。
test('最后一墩：普通墩不进入这个停留（finalTrickPending 只在最后一墩置位）', () => {
  const state = finalTrickState();
  // 每家多发一张，这样打完第一墩还没打完手牌
  for (const p of state.players) p.hand.push(c(`x${p.seat}`, 'D', 3 + p.seat));
  playFinalTrick(state);
  assert.equal(state.round.finalTrickPending, false, '普通墩不该置位');
  assert.equal(
    applyAction(state, { type: 'holdLastTrick' }, playerBySeat(state, 2).id).ok,
    false,
    '普通墩不给按「再看一会」'
  );
});
