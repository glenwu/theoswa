import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, createRoundState, playerBySeat } from '../state.js';
import { applyAction } from '../actions.js';
import { decideBotAction } from '../bot-policy.js';
import { viewerState } from '../viewer.js';
import { rebuildPieces } from '../pieces.js';
import { DOMINANCE_MS, DOMINANCE_HOLD_MS, DEFAULT_TIMINGS } from '../constants.js';

const seeded = () => 0.42;
const c = (id, suit, rank) => ({ id, suit, rank });

// 碾压收尾：一方碾压时系统自动结算剩余轮次，面板摊开四家手牌。
// Glen：「这个时间太短了，应该只有 1 秒，至少要 5 秒，也同样加一个『看多一会』
//   的按钮，30 秒。」
//
// ⚠️ 病根【不在这个面板】：DOMINANCE_MS 本来就是 30 秒。是电脑一进这个阶段
// 就返回 confirmDominance，而任一家确认即结束 —— 所以真人只看得到一瞬间。
// 两头都得改，只改一头都没用：
//   · 服务端：默认停 DOMINANCE_MS，按了「看多一会」拉到 DOMINANCE_HOLD_MS
//   · 电脑：只有四家全是电脑时才立刻点（模拟跑同步循环，计时器不会触发）
function dominanceState({ allBots = false } = {}) {
  const state = createInitialState(seeded);
  state.declarerSeat = 1;
  state.round = createRoundState(1, 1);
  state.round.trumpSuit = 'H';
  state.round.rankCard = 2;
  state.round.leadSeat = 0;
  state.round.turnSeat = 0;
  state.round.kitty = [c('k1', 'C', 5)];
  state.phase = 'DOMINANCE';
  state.round.dominance = {
    winningTeam: 0, remainingTricks: 3, remainingPoints: 25,
    pointsToDefender: true, kittyGrab: false,
  };
  state.round.dominanceHolds = [];
  state.round.dominanceDeadline = Date.now() + DOMINANCE_MS;
  state.timing = { ...DEFAULT_TIMINGS };
  for (const p of state.players) {
    p.hand = [c(`h${p.seat}`, 'S', 3 + p.seat)];
    if (allBots || p.seat !== 0) p.isBot = true;
  }
  rebuildPieces(state);
  return state;
}

test('碾压收尾：停留至少 5 秒，「看多一会」拉到 30 秒', () => {
  assert.ok(DOMINANCE_MS >= 5000, `Glen 要求「至少要 5 秒」，实际 ${DOMINANCE_MS}ms`);
  assert.ok(
    DOMINANCE_HOLD_MS >= 30000,
    `Glen 要求「看多一会……30 秒」，实际 ${DOMINANCE_HOLD_MS}ms`
  );
});

// ⚠️ 这一条是整个修复的核心。原来电脑无条件返回 confirmDominance，
// 面板 1 秒不到就被它点掉了 —— 服务端停多久都没意义。
test('碾压收尾：桌上有真人时，电脑【不】替他点确认', () => {
  const state = dominanceState();            // 座 0 是真人
  const bot = playerBySeat(state, 1);
  const action = decideBotAction(viewerState(state, bot.id));
  assert.notEqual(
    action?.type, 'confirmDominance',
    '电脑一点这个面板就没了，真人连一秒都看不到'
  );
});

// 反向对照：四家全是电脑就得照旧立刻点 —— 模拟跑的是同步循环，
// 服务端的 setTimeout 根本没机会触发，不点就卡死在这一阶段。
test('碾压收尾：四家全是电脑 → 照旧立刻确认（不然模拟会卡住）', () => {
  const state = dominanceState({ allBots: true });
  const bot = playerBySeat(state, 1);
  const action = decideBotAction(viewerState(state, bot.id));
  assert.equal(action?.type, 'confirmDominance');
});

test('碾压收尾：按「看多一会」→ 窗口拉长，名单记上我', () => {
  const state = dominanceState();
  const me = playerBySeat(state, 0);
  const before = state.round.dominanceDeadline;
  const res = applyAction(state, { type: 'holdDominance' }, me.id);
  assert.equal(res.ok, true, res.error?.reason);
  assert.deepEqual(state.round.dominanceHolds, [0]);
  assert.ok(
    state.round.dominanceDeadline > before,
    '按了之后窗口要拉长，不然按了也白按'
  );
  assert.ok(state.round.dominanceDeadline - Date.now() > DOMINANCE_MS);
});

test('碾压收尾：按「继续」→ 名单清空，立刻到点', () => {
  const state = dominanceState();
  const me = playerBySeat(state, 0);
  applyAction(state, { type: 'holdDominance' }, me.id);
  const res = applyAction(state, { type: 'releaseDominance' }, me.id);
  assert.equal(res.ok, true, res.error?.reason);
  assert.deepEqual(state.round.dominanceHolds, []);
  assert.ok(
    state.round.dominanceDeadline <= Date.now(),
    '按住的人都放开了就该马上收 —— 留下来的是他们，说走也该由他们说'
  );
});

// ⚠️ 只有第一个人按下才续期。不然四个人轮流按就能把全场无限拖住 ——
// 口径和最后一墩那套一致。
test('碾压收尾：第二个人再按不续期', () => {
  const state = dominanceState();
  applyAction(state, { type: 'holdDominance' }, playerBySeat(state, 0).id);
  const after1 = state.round.dominanceDeadline;
  playerBySeat(state, 1).isBot = false;
  applyAction(state, { type: 'holdDominance' }, playerBySeat(state, 1).id);
  assert.deepEqual(state.round.dominanceHolds, [0, 1]);
  assert.equal(state.round.dominanceDeadline, after1, '第二个人按不该再续期');
});

test('碾压收尾：同一个人按两次会被拒', () => {
  const state = dominanceState();
  const me = playerBySeat(state, 0);
  applyAction(state, { type: 'holdDominance' }, me.id);
  const res = applyAction(state, { type: 'holdDominance' }, me.id);
  assert.equal(res.ok, false);
});

// 进入 DOMINANCE 时名单必须清空：上一局有人按住过，这一局不能还挂着。
test('碾压收尾：新一轮进入时停留名单清空', () => {
  const state = dominanceState();
  applyAction(state, { type: 'holdDominance' }, playerBySeat(state, 0).id);
  assert.deepEqual(state.round.dominanceHolds, [0]);
  state.round = createRoundState(2, 1);
  assert.deepEqual(state.round.dominanceHolds, [], '新一轮的 state 里必须是空的');
});
