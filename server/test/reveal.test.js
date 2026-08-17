import { test } from 'node:test';
import assert from 'node:assert/strict';
import { starterFromFlip, fallbackTrumpOf } from '../reveal.js';

test('验收17/翻牌定起揭人：n%4 → 1自己 2下家 3对家 0上家（相对翻牌人）', () => {
  // 翻牌人座位 0：下家=3，对家=2，上家=1
  assert.equal(starterFromFlip(5, 0), 0, '5%4=1 → 自己');
  assert.equal(starterFromFlip(2, 0), 3, '2%4=2 → 下家');
  assert.equal(starterFromFlip(11, 0), 2, 'J(11)%4=3 → 对家');
  assert.equal(starterFromFlip(12, 0), 1, 'Q(12)%4=0 → 上家');
  // A = 1
  assert.equal(starterFromFlip(14, 3), 3, 'A=1 → 自己');
  // 翻牌人座位 2
  assert.equal(starterFromFlip(13, 2), 2, 'K(13)%4=1 → 自己');
  assert.equal(starterFromFlip(6, 2), 1, '6%4=2 → 下家(1)');
  assert.equal(starterFromFlip(9, 2), 2, '9%4=1 → 自己');
  assert.equal(starterFromFlip(8, 2), 3, '8%4=0 → 上家(3)');
});

test('验收27：底牌 [大王, 方块9, 黑桃K, 梅花2, …] 打2 → 主牌为梅花（第一个级牌）', () => {
  const cards = [
    { suit: 'JOKER', rank: 16 },
    { suit: 'D', rank: 9 },
    { suit: 'S', rank: 13 },
    { suit: 'C', rank: 2 },
    { suit: 'H', rank: 7 },
    { suit: 'C', rank: 8 },
    { suit: 'D', rank: 3 },
    { suit: 'H', rank: 10 },
  ];
  const { fallbackSuit, trumpSuit } = fallbackTrumpOf(cards, 2);
  assert.equal(fallbackSuit, 'D', '首张非王牌是方块9');
  assert.equal(trumpSuit, 'C', '出现级牌 → 用第一个级牌（梅花2）的花色');
});

test('验收28：底牌 [小王, 红桃7, …] 无级牌 → 主牌为红桃（首张非王牌）', () => {
  const cards = [
    { suit: 'JOKER', rank: 15 },
    { suit: 'H', rank: 7 },
    { suit: 'S', rank: 3 },
    { suit: 'D', rank: 10 },
    { suit: 'C', rank: 9 },
    { suit: 'D', rank: 8 },
    { suit: 'S', rank: 4 },
    { suit: 'C', rank: 6 },
  ];
  const { fallbackSuit, trumpSuit } = fallbackTrumpOf(cards, 2);
  assert.equal(fallbackSuit, 'H');
  assert.equal(trumpSuit, 'H', '无级牌 → fallbackSuit（红桃）');
});

test('揭底定主：级牌检查含副级牌（其他花色的 2）', () => {
  const cards = [
    { suit: 'S', rank: 9 },
    { suit: 'D', rank: 2 }, // 副级牌
    { suit: 'C', rank: 6 },
    { suit: 'H', rank: 3 },
    { suit: 'S', rank: 7 },
    { suit: 'C', rank: 13 },
    { suit: 'H', rank: 8 },
    { suit: 'JOKER', rank: 16 },
  ];
  assert.equal(fallbackTrumpOf(cards, 2).trumpSuit, 'D');
});
