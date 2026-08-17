import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPieceCard,
  rebuildPieces,
  pieceStatusesFor,
  canThrowByStatus,
  missingPieceLabels,
  migratePlayedPieces,
} from '../pieces.js';
import { createInitialState, createRoundState, playerBySeat } from '../state.js';

const card = (id, suit, rank) => ({ id, suit, rank });

test('件的定义：打2时 A/K 都是件；打A时 A 升主不是件；打K时 K 升主不是件；主花色永远不是件', () => {
  assert.equal(isPieceCard(card('x', 'S', 14), 'H', 2), true, '打2：♠A 是件');
  assert.equal(isPieceCard(card('x', 'S', 13), 'H', 2), true, '打2：♠K 是件');
  assert.equal(isPieceCard(card('x', 'S', 14), 'H', 14), false, '打A：♠A 升主，不是件');
  assert.equal(isPieceCard(card('x', 'S', 13), 'H', 14), true, '打A：♠K 仍是件');
  assert.equal(isPieceCard(card('x', 'S', 14), 'H', 13), true, '打K：♠A 仍是件');
  assert.equal(isPieceCard(card('x', 'S', 13), 'H', 13), false, '打K：♠K 升主，不是件');
  assert.equal(isPieceCard(card('x', 'H', 14), 'H', 2), false, '主花色 A 不是件');
  assert.equal(isPieceCard(card('x', 'JOKER', 16), 'H', 2), false, '大鬼不是件');
  assert.equal(isPieceCard(card('x', 'S', 5), 'H', 2), false, '普通牌不是件');
});

test('rebuildPieces：打A时该花色的 A 不进入件表', () => {
  const state = createInitialState(() => 0.42);
  state.declarerSeat = 0;
  state.round = createRoundState(1, 0);
  state.round.trumpSuit = 'H';
  state.round.rankCard = 14; // 打 A
  state.round.kitty = [];
  playerBySeat(state, 0).hand = [
    card('a1', 'S', 14), // ♠A：级牌，不是件
    card('a2', 'S', 13), // ♠K：是件
  ];
  const pieces = rebuildPieces(state);
  const spades = pieces.filter(p => p.suit === 'S');
  assert.equal(spades.length, 1);
  assert.equal(spades[0].rank, 13);
});

test('件状态视图：mine / seen / unseen 映射正确', () => {
  const pieces = [
    { cardId: 'x1', suit: 'S', rank: 14, location: { kind: 'hand', seat: 2 } },
    { cardId: 'x2', suit: 'S', rank: 13, location: { kind: 'played' } },
    { cardId: 'x3', suit: 'C', rank: 14, location: { kind: 'kittyRevealed' } },
  ];
  const mine = pieceStatusesFor(pieces, 'H', 2);
  assert.deepEqual(mine.S.find(p => p.rank === 14).status, 'mine');
  assert.deepEqual(mine.S.find(p => p.rank === 13).status, 'seen');
  assert.deepEqual(mine.C.find(p => p.rank === 14).status, 'seen');
  const others = pieceStatusesFor(pieces, 'H', 0);
  assert.deepEqual(others.S.find(p => p.rank === 14).status, 'unseen', '在别人手上 = 未现');
  assert.equal(mine.H, undefined, '主花色没有件视图');
});

test('甩牌资格判定（裁决口径）：四件全在手✅ / 三件+一件未现❌ / 三件+一件已打出✅ / 四件都打出✅', () => {
  const allMine = [
    { rank: 14, status: 'mine' }, { rank: 14, status: 'mine' },
    { rank: 13, status: 'mine' }, { rank: 13, status: 'mine' },
  ];
  assert.equal(canThrowByStatus(allMine), true);
  const oneUnseen = [
    { rank: 14, status: 'mine' }, { rank: 14, status: 'mine' },
    { rank: 13, status: 'mine' }, { rank: 13, status: 'unseen' },
  ];
  assert.equal(canThrowByStatus(oneUnseen), false);
  const onePlayed = [
    { rank: 14, status: 'mine' }, { rank: 14, status: 'mine' },
    { rank: 13, status: 'mine' }, { rank: 13, status: 'seen' },
  ];
  assert.equal(canThrowByStatus(onePlayed), true);
  const allPlayed = [
    { rank: 14, status: 'seen' }, { rank: 14, status: 'seen' },
    { rank: 13, status: 'seen' }, { rank: 13, status: 'seen' },
  ];
  assert.equal(canThrowByStatus(allPlayed), true, '四件都已打出 → 四家都有资格');
  assert.equal(canThrowByStatus([]), false, '空表（主牌花色等无件）不能甩');
  assert.equal(canThrowByStatus(undefined), false);
});

test('缺件提示：还差 ♠K', () => {
  const items = [
    { rank: 14, status: 'mine' }, { rank: 14, status: 'mine' },
    { rank: 13, status: 'unseen' }, { rank: 13, status: 'mine' },
  ];
  assert.deepEqual(missingPieceLabels('S', items), ['♠K']);
});

test('件迁移：一轮结束后统一迁移，本轮打出的件变 played，其余不变', () => {
  const pieces = [
    { cardId: 'p1', suit: 'S', rank: 14, location: { kind: 'hand', seat: 0 } },
    { cardId: 'p2', suit: 'S', rank: 13, location: { kind: 'hand', seat: 1 } },
    { cardId: 'p3', suit: 'C', rank: 14, location: { kind: 'kittyRevealed' } },
  ];
  const trick = {
    plays: [
      { seat: 0, cards: [{ id: 'p1', suit: 'S', rank: 14 }] },
      { seat: 1, cards: [{ id: 'other', suit: 'H', rank: 7 }] },
      { seat: 2, cards: [{ id: 'x', suit: 'D', rank: 9 }] },
      { seat: 3, cards: [{ id: 'y', suit: 'C', rank: 3 }] },
    ],
  };
  migratePlayedPieces(pieces, trick);
  assert.deepEqual(pieces[0].location, { kind: 'played' });
  assert.deepEqual(pieces[1].location, { kind: 'hand', seat: 1 }, '未打出的件保持原位');
  assert.deepEqual(pieces[2].location, { kind: 'kittyRevealed' }, '底牌件不受影响');
});

test('canThrow 只查状态表：函数签名不含任何人的手牌（结构自查）', () => {
  // canThrowByStatus 只接受状态数组，这是设计约束——
  // 遍历其他三家手牌在这里连参数都拿不到。
  assert.equal(canThrowByStatus.length, 1);
  assert.equal(missingPieceLabels.length, 2);
});
