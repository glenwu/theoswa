import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seatStatusText } from '../../client/src/seatStatus.js';
import { PHASES } from '../constants.js';

const P = extra => ({ seat: 1, team: 1, ready: false, seatLocked: false, isDeclarer: false, ...extra });
const G = (phase, round = null) => ({ phase, round });

test('准备阶段：名字下面显示已准备 / 未准备', () => {
  assert.equal(seatStatusText(G('READY_CHECK'), P({ ready: true })), '已准备✓');
  assert.equal(seatStatusText(G('READY_CHECK'), P({ ready: false })), '未准备');
});

test('换座阶段：显示已确认 / 未确认', () => {
  assert.equal(seatStatusText(G('SEATING'), P({ seatLocked: true })), '已确认✓');
  assert.equal(seatStatusText(G('SEATING'), P()), '未确认');
});

// 这两个阶段原来什么都不显示 —— 四个人干等着，谁也不知道还差谁
test('起揭停留：按 flipConfirms 显示谁点了「知道了」', () => {
  const round = { flipDone: true, flipConfirms: [1, 3] };
  assert.equal(seatStatusText(G('REVEAL_FIRST', round), P({ seat: 1 })), '已准备✓');
  assert.equal(seatStatusText(G('REVEAL_FIRST', round), P({ seat: 2 })), '未准备');
});

test('起揭停留：牌还没翻出来时不显示（那时无所谓等谁）', () => {
  assert.equal(seatStatusText(G('REVEAL_FIRST', { flipDone: false }), P()), null);
});

test('本局小结：按 roundEndConfirms 显示谁点了「看完了」', () => {
  const round = { roundEndConfirms: [0, 1] };
  assert.equal(seatStatusText(G('ROUND_END', round), P({ seat: 1 })), '已看完✓');
  assert.equal(seatStatusText(G('ROUND_END', round), P({ seat: 2 })), '看小结中');
});

test('换底 / 过河阶段的文案不变', () => {
  assert.equal(seatStatusText(G('KITTY_EXCHANGE'), P({ isDeclarer: true })), '换底中');
  assert.equal(seatStatusText(G('KITTY_EXCHANGE'), P()), '等待换底');
  const round = { crossRiver: { doneTeams: [1] } };
  assert.equal(seatStatusText(G('CROSS_RIVER', round), P({ team: 1 })), '已过河');
  assert.equal(seatStatusText(G('CROSS_RIVER', round), P({ team: 0 })), '过河阶段');
});

test('没有「等谁」语义的阶段返回 null，不硬凑文案', () => {
  for (const phase of ['REVEALING', 'DEALING', 'PLAYING', 'DOMINANCE', 'SCORING', 'GAME_OVER']) {
    assert.equal(seatStatusText(G(phase, {}), P()), null, phase);
  }
});

test('每个阶段都走得通，不会因为缺字段抛错', () => {
  for (const phase of PHASES) {
    assert.doesNotThrow(() => seatStatusText(G(phase, {}), P()), phase);
    assert.doesNotThrow(() => seatStatusText(G(phase, null), P()), phase);
  }
  assert.equal(seatStatusText(undefined, P()), null);
});
