import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../state.js';
import { applyAction, ErrorCode } from '../actions.js';

const seeded = () => 0.42;

function makeJoinedState() {
  const state = createInitialState(seeded);
  for (const p of state.players) applyAction(state, { type: 'join' }, p.id);
  return state;
}

test('join：标记在线；未知身份拒绝', () => {
  const state = createInitialState(seeded);
  const res = applyAction(state, { type: 'join' }, 'T');
  assert.equal(res.ok, true);
  assert.equal(state.players.find(p => p.id === 'T').connected, true);
  const bad = applyAction(state, { type: 'join' }, 'X');
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, ErrorCode.UNKNOWN_PLAYER);
});

test('leave：标记掉线', () => {
  const state = makeJoinedState();
  applyAction(state, { type: 'leave' }, 'T');
  assert.equal(state.players.find(p => p.id === 'T').connected, false);
});

test('换座：proposeSwap + acceptSwap 交换座位与队伍', () => {
  const state = makeJoinedState();
  const a = state.players[0];
  const b = state.players[1];
  const seatA = a.seat;
  const seatB = b.seat;
  assert.equal(applyAction(state, { type: 'proposeSwap', targetSeat: seatB }, a.id).ok, true);
  assert.equal(applyAction(state, { type: 'acceptSwap', fromSeat: seatA }, b.id).ok, true);
  assert.equal(state.seatsByPlayer[a.id], seatB);
  assert.equal(state.seatsByPlayer[b.id], seatA);
  const movedA = state.players.find(p => p.id === a.id);
  assert.equal(movedA.seat, seatB);
  assert.equal(movedA.team, seatB % 2, '队伍随座位重算');
  // 四人座位仍覆盖 0..3，不重不漏
  assert.deepEqual(state.players.map(p => p.seat).sort((x, y) => x - y), [0, 1, 2, 3]);
});

test('已确认座位者不能发起/接受换座', () => {
  const state = makeJoinedState();
  const a = state.players[0];
  const b = state.players[1];
  const c = state.players[2];
  applyAction(state, { type: 'confirmSeat' }, a.id);
  const r1 = applyAction(state, { type: 'proposeSwap', targetSeat: b.seat }, a.id);
  assert.equal(r1.error.code, ErrorCode.SEAT_LOCKED);
  const r2 = applyAction(state, { type: 'proposeSwap', targetSeat: a.seat }, c.id);
  assert.equal(r2.error.code, ErrorCode.SEAT_LOCKED, '对方已锁同样拒绝');
});

test('没有待确认请求时 acceptSwap 被拒绝', () => {
  const state = makeJoinedState();
  const b = state.players[1];
  const r = applyAction(state, { type: 'acceptSwap', fromSeat: 0 }, b.id);
  assert.equal(r.error.code, ErrorCode.SWAP_REJECTED);
});

test('四人确认座位 → READY_CHECK；确认后请求被清除', () => {
  const state = makeJoinedState();
  const a = state.players[0];
  const b = state.players[1];
  applyAction(state, { type: 'proposeSwap', targetSeat: b.seat }, a.id);
  for (const p of state.players) applyAction(state, { type: 'confirmSeat' }, p.id);
  assert.equal(state.phase, 'READY_CHECK');
  assert.equal(state.swapProposals.length, 0);
});

test('READY_CHECK：准备可切换；全员准备 → REVEAL_FIRST（庄家未定）', () => {
  const state = makeJoinedState();
  for (const p of state.players) applyAction(state, { type: 'confirmSeat' }, p.id);
  assert.equal(state.phase, 'READY_CHECK');
  applyAction(state, { type: 'ready' }, 'T');
  assert.equal(state.players.find(p => p.id === 'T').ready, true);
  applyAction(state, { type: 'ready' }, 'T');
  assert.equal(state.players.find(p => p.id === 'T').ready, false);
  applyAction(state, { type: 'ready' }, 'T');
  for (const p of state.players) {
    if (p.id !== 'T') applyAction(state, { type: 'ready' }, p.id);
  }
  assert.equal(state.phase, 'REVEAL_FIRST');
  assert.equal(state.flipperSeat, null);
  assert.ok(state.round);
  assert.equal(state.round.roundNumber, 1);
  assert.ok(state.players.every(p => p.ready === false), '进入揭牌后准备标记重置');
});

test('抢按揭牌（服务端先到先得）：先到成功，后到 FLIPPER_ALREADY_CLAIMED；错误阶段拒绝', () => {
  const state = makeJoinedState();
  for (const p of state.players) applyAction(state, { type: 'confirmSeat' }, p.id);
  for (const p of state.players) applyAction(state, { type: 'ready' }, p.id);
  assert.equal(state.phase, 'REVEAL_FIRST');
  const first = state.players[0];
  const second = state.players[1];
  const r1 = applyAction(state, { type: 'claimFlipper' }, first.id);
  assert.equal(r1.ok, true);
  assert.equal(state.flipperSeat, first.seat);
  const r2 = applyAction(state, { type: 'claimFlipper' }, second.id);
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, ErrorCode.FLIPPER_ALREADY_CLAIMED);
  // 错误阶段
  state.phase = 'SEATING';
  const r3 = applyAction(state, { type: 'claimFlipper' }, second.id);
  assert.equal(r3.error.code, ErrorCode.WRONG_PHASE);
});

test('聊天：全阶段可用；空消息拒绝；快捷短语映射正确', () => {
  const state = makeJoinedState();
  assert.equal(applyAction(state, { type: 'chat', text: '  好牌！  ' }, 'T').ok, true);
  assert.equal(state.chat.at(-1).text, '好牌！');
  assert.equal(state.chat.at(-1).from, 'T');
  const bad = applyAction(state, { type: 'chat', text: '   ' }, 'T');
  assert.equal(bad.error.code, ErrorCode.CHAT_INVALID);
  applyAction(state, { type: 'quickChat', phraseId: 'mengmeng' }, 'H');
  assert.equal(state.chat.at(-1).text, '猛猛呐');
  applyAction(state, { type: 'quickChat', phraseId: 'langxian' }, 'H');
  assert.equal(state.chat.at(-1).text, '浪险');
  const badPhrase = applyAction(state, { type: 'quickChat', phraseId: 'nope' }, 'H');
  assert.equal(badPhrase.error.code, ErrorCode.CHAT_INVALID);
});

test('错误阶段的动作一律 WRONG_PHASE', () => {
  const state = createInitialState(seeded);
  applyAction(state, { type: 'join' }, 'T');
  assert.equal(applyAction(state, { type: 'ready' }, 'T').error.code, ErrorCode.WRONG_PHASE);
  assert.equal(applyAction(state, { type: 'claimFlipper' }, 'T').error.code, ErrorCode.WRONG_PHASE);
  assert.equal(applyAction(state, { type: 'confirmSeat' }, 'T').ok, true); // SEATING 合法
});

test('未知动作 → BAD_ACTION', () => {
  const state = makeJoinedState();
  const r = applyAction(state, { type: 'hackTheGame' }, 'T');
  assert.equal(r.error.code, ErrorCode.BAD_ACTION);
});
