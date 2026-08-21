import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, createRoundState, playerBySeat } from '../state.js';
import { applyAction, ErrorCode } from '../actions.js';
import { advanceToReadyCheck, startRevealing } from '../flow.js';
import { viewerState } from '../viewer.js';
import {
  ROUND_END_MS, PLAY_TIMEOUT_MS, TRICK_SETTLE_MS, SCORING_MS,
  REVEAL_DRAW_MS, REVEAL_GRACE_MS, CROSS_RIVER_DECIDE_MS,
  CROSS_RIVER_PICK_MS, AUTO_LAST_MS, FLIP_HOLD_MS, timingsFromEnv,
} from '../constants.js';
import { roundStory } from '../../client/src/roundStory.js';

function roundEndState() {
  const state = createInitialState(() => 0.5);
  state.declarerSeat = 0;
  state.phase = 'ROUND_END';
  const r = createRoundState(1, 0);
  r.trumpSuit = 'H';
  r.rankCard = 2;
  r.roundEndDeadline = Date.now() + ROUND_END_MS;
  state.round = r;
  for (const p of state.players) {
    p.connected = true;
    p.hand = [];
    p.ready = true;
  }
  return state;
}

test('小结停留改为 100 秒（原来 3 秒，来不及复盘）', () => {
  assert.equal(ROUND_END_MS, 100000);
});

test('四人都点「看完了」→ 提前进入下一局准备', () => {
  const state = roundEndState();
  const ids = [...state.players].sort((a, b) => a.seat - b.seat).map(p => p.id);
  for (let i = 0; i < 3; i++) {
    assert.equal(applyAction(state, { type: 'confirmRoundEnd' }, ids[i]).ok, true);
    assert.equal(state.phase, 'ROUND_END', `才 ${i + 1} 个人确认，不能走`);
  }
  assert.equal(applyAction(state, { type: 'confirmRoundEnd' }, ids[3]).ok, true);
  assert.equal(state.phase, 'READY_CHECK', '第 4 个人确认后立即进入准备');
  assert.equal(state.round, null, 'RoundState 已清空');
  assert.ok(state.players.every(p => !p.ready), '准备状态已重置');
});

test('同一人重复确认被拒，不会把人数灌满', () => {
  const state = roundEndState();
  const me = playerBySeat(state, 0);
  assert.equal(applyAction(state, { type: 'confirmRoundEnd' }, me.id).ok, true);
  const again = applyAction(state, { type: 'confirmRoundEnd' }, me.id);
  assert.equal(again.ok, false);
  assert.equal(again.error.code, ErrorCode.ALREADY_VOTED);
  assert.equal(state.round.roundEndConfirms.length, 1);
  assert.equal(state.phase, 'ROUND_END');
});

test('非 ROUND_END 阶段确认小结被拒', () => {
  const state = roundEndState();
  state.phase = 'PLAYING';
  const res = applyAction(state, { type: 'confirmRoundEnd' }, playerBySeat(state, 0).id);
  assert.equal(res.error.code, ErrorCode.WRONG_PHASE);
});

test('确认名单与倒计时截止对四家公开（用于同步倒计时）', () => {
  const state = roundEndState();
  applyAction(state, { type: 'confirmRoundEnd' }, playerBySeat(state, 2).id);
  for (const p of state.players) {
    const v = viewerState(state, p.id);
    assert.deepEqual(v.round.roundEndConfirms, [2], '四家看到同一份确认名单');
    assert.equal(v.round.roundEndDeadline, state.round.roundEndDeadline);
  }
});

test('advanceToReadyCheck：只在 ROUND_END 生效（防止别处误调）', () => {
  const state = roundEndState();
  state.phase = 'PLAYING';
  assert.equal(advanceToReadyCheck(state), false);
  assert.equal(state.phase, 'PLAYING');
  assert.notEqual(state.round, null);
});

// ---- 复盘叙述 ----

const NAMES = { 0: '勝', 1: '麤', 2: '半仙', 3: '旻' };
const nameBySeat = s => NAMES[s];

test('复盘叙述：撬底局讲清抓分来源、跑掉的分、最后一轮与结论', () => {
  const summary = {
    declarerSeat: 0, defenderTrickPoints: 90, runAwayPoints: 90, kittyPoints: 20,
    kittyGrab: true, defenderPoints: 130, transfer: true, upgradedTeam: 1,
    upgradeCount: 2, crossRiverPenalty: 0,
  };
  const history = [
    { trickNo: 1, winnerSeat: 1, points: 30 },
    { trickNo: 2, winnerSeat: 0, points: 90 },
    { trickNo: 3, winnerSeat: 3, points: 60 },
  ];
  const lines = roundStory(summary, history, nameBySeat).join('\n');
  assert.match(lines, /青队（闲家）在 2 轮里抓到台面 90 分/);
  assert.match(lines, /第 3 轮的 60 分（旻 拿下）/, '点出最大的一手');
  assert.match(lines, /90 分直接作废跑掉/);
  assert.match(lines, /撬底成立/);
  assert.match(lines, /最终闲家 P=130，移庄，青队升 2 级/);
});

test('复盘叙述：闲家一分未抓 + 底牌守住', () => {
  const summary = {
    declarerSeat: 0, defenderTrickPoints: 0, runAwayPoints: 180, kittyPoints: 20,
    kittyGrab: false, defenderPoints: 0, transfer: false, upgradedTeam: 0,
    upgradeCount: 5, crossRiverPenalty: 0,
  };
  const history = [{ trickNo: 1, winnerSeat: 0, points: 180 }];
  const lines = roundStory(summary, history, nameBySeat).join('\n');
  assert.match(lines, /一分未抓/);
  assert.match(lines, /守住 —— 底牌 20 分跟着跑掉，没被撬/);
  assert.match(lines, /连庄，金队升 5 级/);
});

test('复盘叙述：三主过河惩罚单独成句', () => {
  const summary = {
    declarerSeat: 0, defenderTrickPoints: 70, runAwayPoints: 110, kittyPoints: 20,
    kittyGrab: true, defenderPoints: 110, transfer: true, upgradedTeam: 1,
    upgradeCount: 9, crossRiverPenalty: 8,
  };
  const lines = roundStory(summary, [{ trickNo: 1, winnerSeat: 1, points: 70 }], nameBySeat).join('\n');
  assert.match(lines, /三主过河又被撬底.*8 张主牌.*额外多升 8 级/);
});

test('复盘叙述：没有 summary 时返回空（不炸）', () => {
  assert.deepEqual(roundStory(null, [], nameBySeat), []);
  assert.deepEqual(roundStory(undefined, undefined, undefined), []);
});

// ---- 节奏默认值必须来自 constants（回归：index.js 曾另写一份，改常量不生效）----

test('timingsFromEnv：无环境变量时每一项都取 constants 的值', () => {
  const t = timingsFromEnv({});
  assert.equal(t.roundEndMs, ROUND_END_MS, '小结停留 —— 就是这一项曾经不生效');
  assert.equal(t.playMs, PLAY_TIMEOUT_MS);
  assert.equal(t.settleMs, TRICK_SETTLE_MS);
  assert.equal(t.scoringMs, SCORING_MS);
  assert.equal(t.drawMs, REVEAL_DRAW_MS);
  assert.equal(t.graceMs, REVEAL_GRACE_MS);
  assert.equal(t.crossRiverDecideMs, CROSS_RIVER_DECIDE_MS);
  assert.equal(t.crossRiverPickMs, CROSS_RIVER_PICK_MS);
  assert.equal(t.autoLastMs, AUTO_LAST_MS);
  assert.ok(Object.values(t).every(Number.isFinite), '不得出现 NaN');
});

test('timingsFromEnv：环境变量可覆盖，空串按未设置处理', () => {
  assert.equal(timingsFromEnv({ ROUND_END_MS: '200' }).roundEndMs, 200);
  assert.equal(timingsFromEnv({ ROUND_END_MS: '' }).roundEndMs, ROUND_END_MS);
  assert.equal(timingsFromEnv({ PLAY_MS: '0' }).playMs, 0, '0 是合法值，不能被当成未设置');
});

test('引擎实际拿到的小结停留 = 100 秒（端到端，不只是常量本身）', async () => {
  const { GameEngine } = await import('../game-engine.js');
  const engine = new GameEngine({ state: createInitialState(() => 0.5), timings: timingsFromEnv({}) });
  engine.clearTimers();
  assert.equal(engine.state.timing.roundEndMs, 100000);
});

// ---- 起揭人定出后的停留与「知道了」确认（REVEAL_FIRST）----

function flipHeldState() {
  const state = createInitialState(() => 0.5);
  state.phase = 'REVEAL_FIRST';
  state.declarerSeat = null;
  state.flipperSeat = 0;
  const r = createRoundState(1, null);
  r.rankCard = 2;
  r.flipDone = true;
  r.revealTurnSeat = 1;
  r.flipHoldDeadline = Date.now() + FLIP_HOLD_MS;
  state.round = r;
  for (const p of state.players) { p.connected = true; p.hand = []; }
  return state;
}

test('起揭人停留默认 10 秒（原来定完立刻开揭，来不及看）', () => {
  assert.equal(FLIP_HOLD_MS, 10000);
  assert.equal(timingsFromEnv({}).flipHoldMs, FLIP_HOLD_MS);
  assert.equal(timingsFromEnv({ FLIP_HOLD_MS: '80' }).flipHoldMs, 80);
});

test('四人都点「知道了」→ 提前开始揭牌', () => {
  const state = flipHeldState();
  const ids = [...state.players].sort((a, b) => a.seat - b.seat).map(p => p.id);
  for (let i = 0; i < 3; i++) {
    assert.equal(applyAction(state, { type: 'confirmFlip' }, ids[i]).ok, true);
    assert.equal(state.phase, 'REVEAL_FIRST', `才 ${i + 1} 个人确认，不能开揭`);
  }
  assert.equal(applyAction(state, { type: 'confirmFlip' }, ids[3]).ok, true);
  assert.equal(state.phase, 'REVEALING');
  assert.equal(state.round.revealTurnSeat, 1, '起揭人不变');
});

test('重复点「知道了」被拒，不会把人数灌满', () => {
  const state = flipHeldState();
  const me = playerBySeat(state, 0);
  assert.equal(applyAction(state, { type: 'confirmFlip' }, me.id).ok, true);
  assert.equal(applyAction(state, { type: 'confirmFlip' }, me.id).error.code, ErrorCode.ALREADY_VOTED);
  assert.equal(state.round.flipConfirms.length, 1);
});

test('起揭人还没定出来时确认被拒', () => {
  const state = flipHeldState();
  state.round.flipDone = false;
  assert.equal(
    applyAction(state, { type: 'confirmFlip' }, playerBySeat(state, 0).id).error.code,
    ErrorCode.WRONG_PHASE
  );
});

test('确认名单与停留截止对四家公开（同步倒计时）', () => {
  const state = flipHeldState();
  applyAction(state, { type: 'confirmFlip' }, playerBySeat(state, 2).id);
  for (const p of state.players) {
    const v = viewerState(state, p.id);
    assert.deepEqual(v.round.flipConfirms, [2]);
    assert.equal(v.round.flipHoldDeadline, state.round.flipHoldDeadline);
    assert.equal(v.round.flipDone, true);
  }
});

test('startRevealing：只在 REVEAL_FIRST 且已定出起揭人时生效', () => {
  const a = flipHeldState();
  a.round.flipDone = false;
  assert.equal(startRevealing(a), false, '起揭人未定不能开揭');
  const b = flipHeldState();
  b.phase = 'PLAYING';
  assert.equal(startRevealing(b), false, '别的阶段不能被误触发');
});
