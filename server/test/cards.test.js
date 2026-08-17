import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeck,
  separateKitty,
  cardPoints,
  playSuitOf,
  compareCards,
  cardStrength,
  sortHand,
  countTrump,
  SUITS,
} from '../cards.js';
import { rankOfLevel } from '../level.js';

const card = (suit, rank, id = `${suit}${rank}`) => ({ id, suit, rank });

test('rankOfLevel：0=2 … 12=A，13=第二圈的2', () => {
  assert.equal(rankOfLevel(0), 2);
  assert.equal(rankOfLevel(11), 13); // K
  assert.equal(rankOfLevel(12), 14); // A
  assert.equal(rankOfLevel(13), 2);  // 第二圈的 2
});

test('buildDeck：108 张、id 唯一、大小王恰好 4 张、每花色 26 张', () => {
  const deck = buildDeck();
  assert.equal(deck.length, 108);
  assert.equal(new Set(deck.map(c => c.id)).size, 108, 'id 互不重复');
  const jokers = deck.filter(c => c.suit === 'JOKER');
  assert.equal(jokers.length, 4);
  assert.equal(jokers.filter(c => c.rank === 15).length, 2, '小王 2 张');
  assert.equal(jokers.filter(c => c.rank === 16).length, 2, '大王 2 张');
  for (const suit of SUITS) {
    assert.equal(deck.filter(c => c.suit === suit).length, 26);
    for (let rank = 2; rank <= 14; rank++) {
      assert.equal(deck.filter(c => c.suit === suit && c.rank === rank).length, 2);
    }
  }
});

test('全场总分 200（两副牌 × 100）', () => {
  const total = buildDeck().reduce((sum, c) => sum + cardPoints(c), 0);
  assert.equal(total, 200);
});

test('separateKitty：从牌堆分离 8 张，牌堆剩 100', () => {
  const deck = buildDeck();
  const kitty = separateKitty(deck);
  assert.equal(kitty.length, 8);
  assert.equal(deck.length, 100);
});

test('playSuitOf 五种情况（阶段2最容易埋雷的函数）', () => {
  // 打 2、主牌红桃
  const ctx = { trumpSuit: 'H', rankCard: 2 };
  assert.equal(playSuitOf(card('H', 7), ctx.trumpSuit, ctx.rankCard), 'TRUMP', '主花色普通牌是主牌');
  assert.equal(playSuitOf(card('H', 2), ctx.trumpSuit, ctx.rankCard), 'TRUMP', '主级牌是主牌');
  assert.equal(playSuitOf(card('S', 2), ctx.trumpSuit, ctx.rankCard), 'TRUMP', '副级牌是主牌（♠2 不是黑桃！）');
  assert.equal(playSuitOf(card('D', 2), ctx.trumpSuit, ctx.rankCard), 'TRUMP', '副级牌是主牌');
  assert.equal(playSuitOf(card('JOKER', 15), ctx.trumpSuit, ctx.rankCard), 'TRUMP', '小王是主牌');
  assert.equal(playSuitOf(card('JOKER', 16), ctx.trumpSuit, ctx.rankCard), 'TRUMP', '大王是主牌');
  assert.equal(playSuitOf(card('S', 7), ctx.trumpSuit, ctx.rankCard), 'S', '副牌普通牌保持原花色');
  assert.equal(playSuitOf(card('C', 14), ctx.trumpSuit, ctx.rankCard), 'C', '副牌 A 保持原花色');
});

test('牌力：大王 > 小王 > 主2 > 副2 > 主花色A > 主花色K > 副牌A', () => {
  const ctx = { trumpSuit: 'H', rankCard: 2 };
  const big = card('JOKER', 16);
  const small = card('JOKER', 15);
  const main2 = card('H', 2);
  const off2 = card('S', 2);
  const trumpA = card('H', 14);
  const trumpK = card('H', 13);
  const sideA = card('S', 14);
  assert.equal(compareCards(big, small, ctx), 1);
  assert.equal(compareCards(small, main2, ctx), 1);
  assert.equal(compareCards(main2, off2, ctx), 1, '主2 大于 副2（验收1）');
  assert.equal(compareCards(off2, trumpA, ctx), 1);
  assert.equal(compareCards(trumpA, trumpK, ctx), 1);
  assert.equal(compareCards(trumpK, sideA, ctx), 1);
  assert.equal(compareCards(big, main2, ctx), 1);
  assert.equal(compareCards(small, sideA, ctx), 1);
});

test('副级牌之间互不比大小（先出者大，compareCards 返回 0）', () => {
  const ctx = { trumpSuit: 'H', rankCard: 2 };
  assert.equal(compareCards(card('S', 2), card('C', 2), ctx), 0);
  assert.equal(compareCards(card('D', 2), card('S', 2), ctx), 0);
});

test('两张完全相同的牌同强度（先出者大）', () => {
  const ctx = { trumpSuit: 'H', rankCard: 2 };
  assert.equal(compareCards(card('H', 7, 'a'), card('H', 7, 'b'), ctx), 0);
});

test('副牌各花色内部 A > K > … > 3', () => {
  const ctx = { trumpSuit: 'H', rankCard: 2 };
  assert.equal(compareCards(card('C', 14), card('C', 13), ctx), 1);
  assert.equal(compareCards(card('C', 4), card('C', 3), ctx), 1);
  assert.equal(compareCards(card('C', 3), card('C', 14), ctx), -1);
});

test('sortHand：主牌组最左（大王→小王→主级牌→副级牌→主花色A→3），其余 S→H→D→C 降序', () => {
  // 打 2、主牌红桃：♠2 是副级牌，必须排进主牌组而不是黑桃组
  const ctx = { trumpSuit: 'H', rankCard: 2 };
  const hand = [
    card('S', 2, 's2'),
    card('C', 13, 'ck'),
    card('H', 2, 'h2'),
    card('H', 14, 'ha'),
    card('S', 14, 'sa'),
    card('D', 9, 'd9'),
    card('JOKER', 16, 'bj'),
    card('S', 3, 's3'),
    card('H', 7, 'h7'),
    card('JOKER', 15, 'sj'),
  ];
  const sorted = sortHand(hand, ctx).map(c => c.id);
  assert.deepEqual(sorted, ['bj', 'sj', 'h2', 's2', 'ha', 'h7', 'sa', 's3', 'd9', 'ck']);
  assert.equal(countTrump(hand, ctx), 6, '主牌 6 张：大王/小王/主2/副2/红桃A/红桃7');
});

test('sortHand：主牌花色组不重复出现（主花色只进主牌组，副级牌进主牌组）', () => {
  const ctx = { trumpSuit: 'S', rankCard: 5 };
  const hand = [card('S', 9), card('H', 9), card('S', 5), card('C', 5)];
  const sorted = sortHand(hand, ctx).map(c => c.id);
  // 主牌组：♠5(主级牌998) → ♣5(副级牌997！属于主牌) → ♠9(主花色909)；然后 H 组 ♥9
  assert.deepEqual(sorted, ['S5', 'C5', 'S9', 'H9']);
  assert.equal(countTrump(hand, ctx), 3);
});

test('cardStrength：大王/小王在所有级牌与主牌之上', () => {
  const ctx = { trumpSuit: 'C', rankCard: 14 }; // 打 A 主梅花
  assert.ok(cardStrength(card('JOKER', 16), ctx) > cardStrength(card('C', 14), ctx));
  assert.ok(cardStrength(card('C', 14), ctx) > cardStrength(card('S', 14), ctx), '主A 大于 副A');
});
