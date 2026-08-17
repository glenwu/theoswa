import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextSeat, oppositeSeat, prevSeat, seatOrderFrom } from '../rotation.js';

test('验收15：逆时针顺序 0 → 3 → 2 → 1 → 0', () => {
  assert.equal(nextSeat(0), 3);
  assert.equal(nextSeat(3), 2);
  assert.equal(nextSeat(2), 1);
  assert.equal(nextSeat(1), 0);
});

test('对家 = 座位 +2（同队另一人）', () => {
  assert.equal(oppositeSeat(0), 2);
  assert.equal(oppositeSeat(1), 3);
  assert.equal(oppositeSeat(2), 0);
  assert.equal(oppositeSeat(3), 1);
});

test('上家 = 座位 +1', () => {
  assert.equal(prevSeat(0), 1);
  assert.equal(prevSeat(1), 2);
  assert.equal(prevSeat(2), 3);
  assert.equal(prevSeat(3), 0);
});

test('seatOrderFrom 从任意座位开始都是逆时针整圈', () => {
  for (const start of [0, 1, 2, 3]) {
    assert.deepEqual(
      seatOrderFrom(start),
      [start, (start + 3) % 4, (start + 2) % 4, (start + 1) % 4]
    );
  }
});
