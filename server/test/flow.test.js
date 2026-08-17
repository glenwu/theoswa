import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, createRoundState } from '../state.js';
import { chooseRevealEntry, voidRound, enterFallback } from '../flow.js';
import { applyAction } from '../actions.js';

const seeded = () => 0.42;

function readyAll(state) {
  for (const p of state.players) applyAction(state, { type: 'ready' }, p.id);
}

test('庄家未定（declarerSeat=null）→ REVEAL_FIRST，与局数无关', () => {
  const state = createInitialState(seeded);
  state.declarerSeat = null;
  assert.equal(chooseRevealEntry(state), 'REVEAL_FIRST');
  // 模拟“局数已推进”但庄家仍未定（连续流局场景）——仍走 REVEAL_FIRST，绝不误入 REVEALING
  state.round = { roundNumber: 3 };
  assert.equal(chooseRevealEntry(state), 'REVEAL_FIRST');
});

test('庄家已定 → REVEALING（固定由庄家先揭）', () => {
  const state = createInitialState(seeded);
  state.declarerSeat = 1;
  assert.equal(chooseRevealEntry(state), 'REVEALING');
});

test('配套要求3：第一局流局3次后，第4次仍走 REVEAL_FIRST，roundNumber 仍为1，级别不变', () => {
  const state = createInitialState(seeded);
  // 完成 SEATING（全部连接 + 确认座位）→ READY_CHECK
  for (const p of state.players) applyAction(state, { type: 'join' }, p.id);
  for (const p of state.players) applyAction(state, { type: 'confirmSeat' }, p.id);
  assert.equal(state.phase, 'READY_CHECK');

  readyAll(state);
  assert.equal(state.phase, 'REVEAL_FIRST');
  assert.equal(state.round.roundNumber, 1);

  for (let i = 0; i < 3; i++) {
    // 模拟 100 张揭完无人亮牌 → 流局
    state.phase = 'REVEALING';
    voidRound(state);
    assert.equal(state.phase, 'READY_CHECK');
    assert.equal(state.declarerSeat, null);
    assert.equal(state.round.roundNumber, 1, '流局不递增局数');
    readyAll(state);
    assert.equal(state.phase, 'REVEAL_FIRST', '庄家未定 → 仍走 REVEAL_FIRST');
    assert.equal(state.round.roundNumber, 1);
  }
  assert.deepEqual(state.teamLevels, [0, 0], '流局不改变级别');
});

test('防御：流局与揭底定主永远互斥（庄家已定时流局抛错，庄家未定时揭底抛错）', () => {
  const withDeclarer = createInitialState(seeded);
  withDeclarer.declarerSeat = 1;
  withDeclarer.round = createRoundState(1, 1);
  assert.throws(() => voidRound(withDeclarer), /流局防御失败/);

  const withoutDeclarer = createInitialState(seeded);
  withoutDeclarer.declarerSeat = null;
  withoutDeclarer.round = createRoundState(1, null);
  assert.throws(() => enterFallback(withoutDeclarer), /揭底定主防御失败/);
});
