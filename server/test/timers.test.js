import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GameEngine } from '../game-engine.js';
import { createInitialState, createRoundState, playerBySeat } from '../state.js';
import { buildDeck, separateKitty, sortHand } from '../cards.js';
import { rebuildPieces } from '../pieces.js';
import {
  PHASES, DEFAULT_TIMINGS, TIMING_ENV_KEYS, timingsFromEnv, KITTY_SIZE,
} from '../constants.js';

const seeded = () => 0.42;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 这三个阶段设计上就是等人点，没有服务端兜底是对的：
// SEATING/READY_CHECK 卡住只是开局前多等一会儿，GAME_OVER 已经结束。
const WAITING_BY_DESIGN = new Set(['SEATING', 'READY_CHECK', 'GAME_OVER']);

// 造一个「该阶段的典型状态」，只为让 scheduleTimers 走到对应分支
function stateInPhase(phase) {
  const s = createInitialState(seeded);
  s.phase = phase;
  s.declarerSeat = 0;
  s.flipperSeat = 0;
  s.round = createRoundState(1, 0);
  const r = s.round;
  r.trumpSuit = phase === 'REVEALING' ? null : 'S';
  r.rankCard = 2;
  r.turnSeat = 0;
  r.leadSeat = 0;
  r.crossRiver = { doneTeams: [], passedSeats: [], active: [], decideDeadline: Date.now() + 1e6 };
  r.dominance = {
    winningTeam: 0, remainingTricks: 3, remainingPoints: 20,
    pointsToDefender: true, kittyGrab: true,
  };
  r.kitty = [{ id: 'k0', suit: 'S', rank: 3 }];
  return s;
}

// 换底阶段曾经完全没有兜底计时器：庄家临时走开或掉线，四个人一起卡死
// —— 掉线不会转电脑，出牌都有 60 秒自动打，唯独最长的那个单人决策没有。
// 这条把「每个等人的阶段都必须能自愈」变成硬约束。
test('每个非「设计上等人」的阶段都必须有服务端兜底计时器', () => {
  const missing = [];
  for (const phase of PHASES) {
    if (WAITING_BY_DESIGN.has(phase)) continue;
    const engine = new GameEngine({ state: stateInPhase(phase), broadcast: () => {} });
    const names = [...engine.timers.keys()];
    engine.clearTimers();
    if (names.length === 0) missing.push(phase);
  }
  assert.deepEqual(missing, [], `这些阶段没有任何计时器，全员挂机会永久卡死：${missing.join(', ')}`);
});

// 真正咬人的不是「没有计时器」，是「计时器的延时算出来是 NaN」——
// setTimeout(NaN) 会立刻触发。新增 kittyExchangeMs 时 state.js 那份手抄的
// timing 默认值没跟着改，t.kittyExchangeMs 就是 undefined，
// `now + undefined` = NaN，换底一进去就被自动埋掉了。
test('所有阶段计时器的延时都是有限非负数（NaN 会立刻触发）', () => {
  const bad = [];
  const realSetTimeout = globalThis.setTimeout;
  for (const phase of PHASES) {
    const delays = [];
    globalThis.setTimeout = (fn, ms) => {
      delays.push(ms);
      return realSetTimeout(() => {}, 0);
    };
    let engine;
    try {
      engine = new GameEngine({ state: stateInPhase(phase), broadcast: () => {} });
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    engine.clearTimers();
    for (const ms of delays) {
      if (!Number.isFinite(ms) || ms < 0) bad.push(`${phase}: ${ms}`);
    }
  }
  assert.deepEqual(bad, [], `延时非法：${bad.join('; ')}`);
});

// ---- 节奏默认值只能有一份 ----

test('createInitialState 的 timing 与 DEFAULT_TIMINGS 完全一致（不许再手抄一份）', () => {
  assert.deepEqual(createInitialState(seeded).timing, { ...DEFAULT_TIMINGS });
});

test('DEFAULT_TIMINGS 与 TIMING_ENV_KEYS 键集合相同（新增节奏不会漏掉环境变量）', () => {
  assert.deepEqual(Object.keys(DEFAULT_TIMINGS).sort(), Object.keys(TIMING_ENV_KEYS).sort());
});

test('每个节奏默认值都是有限正数', () => {
  for (const [key, value] of Object.entries(DEFAULT_TIMINGS)) {
    assert.ok(Number.isFinite(value) && value > 0, `${key} = ${value}`);
  }
});

test('timingsFromEnv：环境变量能覆盖，未设置时回落到默认值', () => {
  const t = timingsFromEnv({ KITTY_MS: '5000', DOMINANCE_MS: '' });
  assert.equal(t.kittyExchangeMs, 5000, '设了就用设的');
  assert.equal(t.dominanceMs, DEFAULT_TIMINGS.dominanceMs, '空字符串视为未设置');
  assert.equal(t.playMs, DEFAULT_TIMINGS.playMs, '没提到的照常回落');
  assert.deepEqual(Object.keys(t).sort(), Object.keys(DEFAULT_TIMINGS).sort());
});

// ---- 两个新兜底的实际行为（光有计时器不算数，得真能把局推下去）----

// 直接摆一个换底局面：庄家 33 张（25 + 并进来的 8 张底牌），其余三家 25 张
function kittyExchangeState() {
  const s = createInitialState(seeded);
  s.phase = 'KITTY_EXCHANGE';
  s.declarerSeat = 0;
  s.round = createRoundState(1, 0);
  const r = s.round;
  r.trumpSuit = 'S';
  r.rankCard = 2;
  const deck = buildDeck();
  separateKitty(deck); // 丢掉 8 张，剩 100
  const ctx = { trumpSuit: 'S', rankCard: 2 };
  for (const p of s.players) {
    p.hand = sortHand(deck.splice(0, p.seat === 0 ? 33 : 25), ctx);
  }
  r.kitty = [];
  return s;
}

test('换底超时：服务端自动埋 8 张并推进到过河阶段（庄家掉线不再卡死全场）', async () => {
  const s = kittyExchangeState();
  const before = playerBySeat(s, 0).hand.length;
  assert.equal(before, 33);

  const engine = new GameEngine({
    state: s,
    timings: { kittyExchangeMs: 30 },
    broadcast: () => {},
  });
  await sleep(160);
  engine.clearTimers();

  assert.notEqual(s.phase, 'KITTY_EXCHANGE', '不能还卡在换底');
  assert.equal(playerBySeat(s, 0).hand.length, 33 - KITTY_SIZE, '庄家剩 25 张');
  assert.equal(s.round.kitty.length, KITTY_SIZE, '底牌 8 张');
  assert.match(s.log.map(l => l.text).join('\n'), /换底超时/, '日志说清是自动埋的');
});

test('换底超时埋的是「最没用的 8 张」，不是随手抓 —— 不该把大鬼埋掉', async () => {
  const s = kittyExchangeState();
  const engine = new GameEngine({ state: s, timings: { kittyExchangeMs: 30 }, broadcast: () => {} });
  await sleep(160);
  engine.clearTimers();
  const buriedRanks = s.round.kitty.map(c => c.rank);
  assert.ok(!buriedRanks.includes(16), '大鬼不该被埋');
  assert.ok(!buriedRanks.includes(15), '小鬼不该被埋');
});

test('碾压确认超时：自动结算，不会带着四家明牌永久停在 DOMINANCE', async () => {
  const s = stateInPhase('DOMINANCE');
  s.round.trickHistory = [{ trickNo: 1, leadSeat: 0, plays: [], winnerSeat: 0, points: 0 }];
  s.round.defenderTrickPoints = 0;
  s.round.runAwayPoints = 0;
  for (const p of s.players) p.hand = [];
  rebuildPieces(s);

  const engine = new GameEngine({ state: s, timings: { dominanceMs: 30 }, broadcast: () => {} });
  await sleep(160);
  engine.clearTimers();

  assert.notEqual(s.phase, 'DOMINANCE', '必须离开 DOMINANCE');
  assert.match(s.log.map(l => l.text).join('\n'), /碾压收尾确认超时/);
});
