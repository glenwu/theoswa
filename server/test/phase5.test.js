import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, createRoundState, playerBySeat } from '../state.js';
import { applyAction, ErrorCode } from '../actions.js';
import { pickAutoCards } from '../trick.js';
import { resetGameState } from '../state.js';

const seeded = () => 0.42;
const c = (id, suit, rank) => ({ id, suit, rank });

test('陈旧状态防护：客户端 phase 与服务端不一致 → STALE_STATE；一致/缺省放行', () => {
  const state = createInitialState(seeded);
  applyAction(state, { type: 'join' }, 'T');
  // 一致放行
  const ok = applyAction(state, { type: 'confirmSeat', phase: 'SEATING' }, 'T');
  assert.equal(ok.ok, true);
  // 不一致拒绝（模拟客户端还停在旧阶段）
  const stale = applyAction(state, { type: 'confirmSeat', phase: 'READY_CHECK' }, 'T');
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, ErrorCode.STALE_STATE);
  assert.match(stale.error.reason, /READY_CHECK → SEATING/);
  // 不带 phase（旧客户端/冒烟脚本）不拦截
  assert.equal(applyAction(state, { type: 'chat', text: 'hi' }, 'T').ok, true);
  // 聊天等阶段无关动作豁免
  state.phase = 'PLAYING';
  assert.equal(applyAction(state, { type: 'chat', text: 'x', phase: 'SEATING' }, 'T').ok, true);
});

test('自动出牌选择：首家最小单张（优先非主牌）；跟牌按规则取最小合法组', () => {
  const ctx = { trumpSuit: 'H', rankCard: 2 };
  // 首家：最小非主牌
  const hand = [c('h1', 'H', 9), c('s1', 'S', 3), c('s2', 'S', 7), c('d1', 'D', 4)];
  assert.deepEqual(pickAutoCards(hand, null, ctx).map(x => x.id), ['s1'], '最小非主牌 ♠3');
  const allTrump = [c('h1', 'H', 9), c('h2', 'H', 7)];
  assert.deepEqual(pickAutoCards(allTrump, null, ctx).map(x => x.id), ['h2'], '全主牌 → 最小主牌');

  // 跟牌：持 3 张黑桃、首家甩 2 张 → 出最小 2 张
  const hand3 = [c('s1', 'S', 9), c('s2', 'S', 7), c('s3', 'S', 3), c('d1', 'D', 4)];
  const lead2 = { playSuit: 'S', cards: [c('x1', 'S', 5), c('x2', 'S', 5)] };
  assert.deepEqual(pickAutoCards(hand3, lead2, ctx).map(x => x.id), ['s3', 's2']);

  // 跟牌：持 1 张黑桃、首家甩 3 张 → 黑桃全出 + 最小补齐
  const hand1 = [c('s1', 'S', 9), c('d1', 'D', 4), c('d2', 'D', 8), c('c1', 'C', 3)];
  const lead3 = { playSuit: 'S', cards: [c('x1', 'S', 3), c('x2', 'S', 3), c('x3', 'S', 3)] };
  assert.deepEqual(pickAutoCards(hand1, lead3, ctx).map(x => x.id), ['s1', 'c1', 'd1']);

  // 跟牌：无该花色 → N 张最小主牌杀；主牌不够 → 垫最小 N 张
  const noSuit = [c('h1', 'H', 9), c('h2', 'H', 7), c('h3', 'H', 5), c('d1', 'D', 4)];
  assert.deepEqual(pickAutoCards(noSuit, lead2, ctx).map(x => x.id), ['h3', 'h2'], '2 张主牌杀');
  const fewTrump = [c('h1', 'H', 9), c('d1', 'D', 4), c('d2', 'D', 8), c('c1', 'C', 3)];
  assert.deepEqual(pickAutoCards(fewTrump, lead3, ctx).map(x => x.id), ['c1', 'd1', 'd2'], '主牌不足 → 垫最小 3 张');
});

test('再来一局：级别/局数/庄家归零；座位默认保留（直接准备），可选重新随机', () => {
  const state = createInitialState(seeded);
  state.teamLevels = [5, 7];
  state.declarerSeat = 2;
  state.rounds.push({ roundNumber: 3 });
  state.phase = 'GAME_OVER';
  state.gameWinnerTeam = 0;
  const seatsBefore = { ...state.seatsByPlayer };

  resetGameState(state, { reshuffleSeats: false });
  assert.equal(state.phase, 'READY_CHECK', '座位保留 → 直接准备');
  assert.deepEqual(state.seatsByPlayer, seatsBefore, '座位不变');
  assert.deepEqual(state.teamLevels, [0, 0]);
  assert.equal(state.declarerSeat, null);
  assert.equal(state.round, null);
  assert.equal(state.rounds.length, 0);
  assert.equal(state.gameWinnerTeam, null);

  const state2 = createInitialState(seeded);
  const seatsBefore2 = { ...state2.seatsByPlayer };
  resetGameState(state2, { reshuffleSeats: true });
  assert.equal(state2.phase, 'SEATING', '重新随机 → 重新换座确认');
  assert.ok(state2.players.every(p => p.seatLocked === false));
  // 重新随机后四人座位仍覆盖 0..3
  assert.deepEqual(state2.players.map(p => p.seat).sort((a, b) => a - b), [0, 1, 2, 3]);
});
