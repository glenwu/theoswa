import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState } from '../state.js';
import { applyAction } from '../actions.js';
import { viewerState } from '../viewer.js';

const seeded = () => 0.42;

function readyState() {
  const state = createInitialState(seeded);
  for (const p of state.players) applyAction(state, { type: 'join' }, p.id);
  for (const p of state.players) applyAction(state, { type: 'confirmSeat' }, p.id);
  for (const p of state.players) applyAction(state, { type: 'ready' }, p.id);
  return state;
}

test('viewerState：you 与观看者一致；players 只含 handCount 不含 hand', () => {
  const state = readyState();
  for (const p of state.players) {
    const view = viewerState(state, p.id);
    assert.equal(view.you.id, p.id);
    assert.equal(view.you.seat, p.seat);
    assert.ok(Array.isArray(view.you.hand));
    assert.equal(typeof view.you.trumpCount, 'number');
    for (const q of view.players) {
      assert.equal('hand' in q, false, '不得向任何人下发他人手牌');
      assert.equal(typeof q.handCount, 'number');
    }
  }
});

test('安全底线：服务端内部持有手牌时，payload 只暴露本人手牌', () => {
  const state = readyState();
  for (const p of state.players) p.hand = [{ id: `${p.id}-card-1`, suit: 'S', rank: 7 }];
  for (const p of state.players) {
    const view = viewerState(state, p.id); // 扫描抛错即测试失败
    assert.equal(view.you.hand.length, 1);
    assert.equal(view.you.hand[0].id, `${p.id}-card-1`);
  }
});

test('viewerState：未知观看者返回 null', () => {
  const state = readyState();
  assert.equal(viewerState(state, 'X'), null);
});

test('viewerState：揭牌人、庄家标记公开可见；翻牌前底牌不可见', () => {
  const state = readyState();
  applyAction(state, { type: 'claimFlipper' }, 'T');
  const flipperSeat = state.seatsByPlayer.T;
  const view = viewerState(state, 'H');
  assert.equal(view.flipperSeat, flipperSeat);
  assert.equal(view.players.find(p => p.seat === flipperSeat).isFlipper, true);
  assert.equal(view.declarerSeat, null);
  assert.equal(view.round.roundNumber, 1);
  assert.equal(view.round.deck, undefined, '牌堆不下发');
  assert.equal(view.round.kittyCount, 0, '翻牌前底牌未分离');
});

test('件追踪面板保密断言：件在 B 手上时，A/C/D 的 piecesView 完全相同且都显示未现', () => {
  const state = readyState();
  // 构造换底完成状态：♠A 在座位2（B 的座位）手上，另一件在底牌
  const bSeat = state.seatsByPlayer.B;
  state.declarerSeat = state.seatsByPlayer.T;
  state.round.trumpSuit = 'H';
  state.round.rankCard = 2;
  state.round.kitty = [{ id: 'k1', suit: 'S', rank: 13 }]; // ♠K 埋底（公开）
  for (const p of state.players) p.hand = [];
  const b = state.players.find(p => p.seat === bSeat);
  b.hand = [{ id: 'b1', suit: 'S', rank: 14 }]; // ♠A 在 B 手上（暗牌）
  state.phase = 'PLAYING';
  const pieces = [
    { cardId: 'b1', suit: 'S', rank: 14, location: { kind: 'hand', seat: bSeat } },
    { cardId: 'k1', suit: 'S', rank: 13, location: { kind: 'kittyRevealed' } },
  ];
  state.round.pieces = pieces;

  const bView = viewerState(state, 'B');
  assert.equal(bView.round.piecesView.S.find(x => x.rank === 14).status, 'mine', 'B 自己看到在我手上');
  assert.equal(bView.round.piecesView.S.find(x => x.rank === 13).status, 'seen');

  const others = ['T', 'H', 'M'].map(id => viewerState(state, id));
  for (const v of others) {
    assert.equal(v.round.piecesView.S.find(x => x.rank === 14).status, 'unseen', '别人看到未现');
    assert.equal(v.round.piecesView.S.find(x => x.rank === 13).status, 'seen');
  }
  // A/C/D 三人的 piecesView 完全一致（除 mine 外）
  assert.deepEqual(others[0].round.piecesView, others[1].round.piecesView);
  assert.deepEqual(others[0].round.piecesView, others[2].round.piecesView);
});
