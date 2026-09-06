// 埋底亮件的大图（Glen 2026-09-06）：
//   「如果庄家埋底有件，把件大一点显示在屏幕中间，停留 3 秒，
//     然后动态效果收到放埋底的 8 张牌那边。」
//
// 三块要钉：起点由服务端给（四家对齐）、分段判定、以及飞行落点靠的那个 DOM id。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createInitialState, createRoundState, playerBySeat } from '../state.js';
import { applyAction } from '../actions.js';
import { SUITS } from '../cards.js';
import { viewerState } from '../viewer.js';
import {
  kittySpotlightStage,
  KITTY_SPOTLIGHT_HOLD_MS,
  KITTY_SPOTLIGHT_FLY_MS,
} from '../../client/src/kittySpotlight.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const panel = readFileSync(path.join(root, 'client/src/components/TablePanel.jsx'), 'utf8');

function exchangeState() {
  const state = createInitialState(() => 0.42);
  for (const p of state.players) applyAction(state, { type: 'join' }, p.id);
  const declarerSeat = state.seatsByPlayer.T;
  state.declarerSeat = declarerSeat;
  state.round = createRoundState(1, declarerSeat);
  state.round.trumpSuit = 'H';
  state.round.rankCard = 2;
  state.round.kitty = [];
  const kittyCards = [
    { id: 'k1', suit: 'S', rank: 14 }, // ♠A 件
    { id: 'k2', suit: 'S', rank: 13 }, // ♠K 件
    { id: 'k3', suit: 'H', rank: 14 }, // 主花色 A，不是件
    { id: 'k4', suit: 'JOKER', rank: 16 },
    { id: 'k5', suit: 'C', rank: 5 },
    { id: 'k6', suit: 'C', rank: 10 },
    { id: 'k7', suit: 'H', rank: 7 },
    { id: 'k8', suit: 'D', rank: 3 },
  ];
  const handCards = Array.from({ length: 25 }, (unused, i) => ({
    id: `h${i}`, suit: SUITS[i % 4], rank: 3 + (i % 10),
  }));
  playerBySeat(state, declarerSeat).hand = [...handCards, ...kittyCards];
  state.phase = 'KITTY_EXCHANGE';
  return state;
}

// 起点必须来自服务端：各端拿自己的收包时刻记时，慢的那一家会看到更短的一段，
// 甚至整段错过 —— 这是「四家同步」那条底线（见 dominance / 停留展示的做法）。
test('埋底亮件：服务端记下埋底时刻，四家在 view 里拿到同一个值', () => {
  const state = exchangeState();
  assert.equal(state.round.kittyBuriedAt, null, '埋底之前是空的');
  const before = Date.now();
  const res = applyAction(
    state, { type: 'buryKitty', cardIds: ['k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8'] }, 'T'
  );
  assert.equal(res.ok, true);
  const at = state.round.kittyBuriedAt;
  assert.ok(typeof at === 'number' && at >= before, `埋底时刻没记下（${at}）`);
  const seen = state.players.map(p => viewerState(state, p.id).round.kittyBuriedAt);
  assert.deepEqual(seen, [at, at, at, at], '四家看到的埋底时刻必须一样');
  // 亮出来的那两支件也是公开的（这一条本来就有，这里连着确认大图有东西可画）
  assert.deepEqual(
    viewerState(state, 'H').round.kittyRevealedPieces,
    [{ suit: 'S', rank: 14 }, { suit: 'S', rank: 13 }]
  );
});

const HOLD = KITTY_SPOTLIGHT_HOLD_MS;
const FLY = KITTY_SPOTLIGHT_FLY_MS;
const gameAt = (phase, extra = {}) => ({
  phase,
  round: { kittyRevealedPieces: [{ suit: 'S', rank: 14 }], kittyBuriedAt: 1000, ...extra },
});

test('埋底亮件：先停 3 秒（hold），再飞 0.7 秒（fly），然后收工', () => {
  const g = gameAt('PLAYING');
  assert.equal(kittySpotlightStage(g, 1000), 'hold');
  assert.equal(kittySpotlightStage(g, 1000 + HOLD - 1), 'hold');
  assert.equal(kittySpotlightStage(g, 1000 + HOLD), 'fly');
  assert.equal(kittySpotlightStage(g, 1000 + HOLD + FLY - 1), 'fly');
  assert.equal(kittySpotlightStage(g, 1000 + HOLD + FLY), null);
  // 中途进来的人（刷新、掉线重连）不该被倒放一遍
  assert.equal(kittySpotlightStage(g, 1000 + 60_000), null);
});

// ⚠️ 阶段闸必须带上 CROSS_RIVER：埋完底先进过河阶段，没人够格才立刻进 PLAYING。
// 只认 PLAYING 的话，一旦有人发起过河（15 秒决策窗），这 3.7 秒的窗口就整个错过。
test('埋底亮件：过河阶段也要显示，换底阶段和结算阶段不显示', () => {
  assert.equal(kittySpotlightStage(gameAt('CROSS_RIVER'), 1000), 'hold');
  assert.equal(kittySpotlightStage(gameAt('PLAYING'), 1000), 'hold');
  assert.equal(kittySpotlightStage(gameAt('KITTY_EXCHANGE'), 1000), null);
  assert.equal(kittySpotlightStage(gameAt('SCORING'), 1000), null);
});

test('埋底亮件：没埋件 / 没记下时刻 / 时钟倒着走 → 什么都不弹', () => {
  assert.equal(kittySpotlightStage(gameAt('PLAYING', { kittyRevealedPieces: [] }), 1000), null);
  assert.equal(kittySpotlightStage(gameAt('PLAYING', { kittyBuriedAt: null }), 1000), null);
  assert.equal(kittySpotlightStage(gameAt('PLAYING'), 900), null, '时钟偏差不能倒放');
  assert.equal(kittySpotlightStage({ phase: 'PLAYING' }, 1000), null, '没有 round');
});

// 飞行的落点是运行时量「底牌那一排」的位置。id 一旦被谁顺手删掉，
// 动画不会报错，只会悄悄退回默认的往下 90px —— 那种失效最难发现。
test('埋底亮件：底牌那一排挂着飞行落点用的 id，两处版式都挂', () => {
  assert.ok(
    /const KITTY_ROW_ID = '([\w-]+)';/.test(panel),
    '落点用的 id 常量不见了'
  );
  const uses = panel.match(/id=\{KITTY_ROW_ID\}/g) ?? [];
  assert.equal(uses.length, 2, `窄屏和宽屏两套底牌行都要挂 id，实际挂了 ${uses.length} 处`);
  assert.ok(
    panel.includes("document.getElementById(KITTY_ROW_ID)"),
    '飞行落点没有去量那一排的真实位置'
  );
});
