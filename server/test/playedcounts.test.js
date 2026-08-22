import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playedCounts, totalCounts } from '../../client/src/playedCounts.js';
import { buildDeck, playSuitOf } from '../cards.js';

const C = (suit, rank, i = 0) => ({ id: `${suit}${rank}_${i}`, suit, rank });
const trick = (...cards) => ({ plays: cards.map((c, i) => ({ seat: i, cards: [c] })) });

test('统计已打出的牌：主牌含大小鬼，副牌按门分开', () => {
  const round = {
    trumpSuit: 'H', rankCard: 2,
    trickHistory: [
      trick(C('JOKER', 16), C('JOKER', 16, 1), C('H', 9), C('S', 5)),
      trick(C('JOKER', 15), C('D', 2), C('C', 7), C('S', 9)),
    ],
    currentTrick: [{ seat: 0, cards: [C('H', 13)] }],
  };
  const n = playedCounts(round);
  assert.equal(n.bigJoker, 2);
  assert.equal(n.smallJoker, 1);
  // 主 = 2 大鬼 + 1 小鬼 + ♥9 + ♥K + ♦2（副级牌也是主牌）
  assert.equal(n.trump, 6, '大小鬼与副级牌都算主牌');
  assert.equal(n.S, 2);
  assert.equal(n.C, 1);
  assert.equal(n.D, 0, '♦2 是副级牌 → 算进主，不算方块');
  assert.equal(n.H, 0, '主花色的牌算进主，不再单列');
});

// ⚠️ round.lastTrick 和 trickHistory 的最后一项是【同一个对象】
//（actions.js 里先 push 进 trickHistory 再赋给 lastTrick）。
// 把它也算一遍，刚打完的那一墩就会整整翻倍。
test('不重复计数：lastTrick 与 trickHistory 末项是同一对象', () => {
  const last = trick(C('S', 5), C('S', 6), C('S', 7), C('S', 8));
  const round = {
    trumpSuit: 'H', rankCard: 2,
    trickHistory: [last],
    lastTrick: last,          // 服务端就是这么放的
    currentTrick: [],
  };
  assert.equal(playedCounts(round).S, 4, '四张黑桃就是 4，不是 8');
});

test('空局面 / 缺字段都不炸', () => {
  assert.deepEqual(playedCounts(null), { trump: 0, bigJoker: 0, smallJoker: 0, S: 0, H: 0, D: 0, C: 0 });
  assert.equal(playedCounts({ trumpSuit: 'H', rankCard: 2 }).trump, 0);
  assert.equal(playedCounts({ trumpSuit: 'H', rankCard: 2, trickHistory: [{ }] }).trump, 0);
});

// 总数写死在 totalCounts 里，容易和真实牌组脱节 —— 直接拿 buildDeck 对一遍
test('totalCounts 与真实牌组一致（108 张按主/副实际数一遍）', () => {
  for (const trumpSuit of ['S', 'H', 'D', 'C']) {
    const rankCard = 2;
    const actual = { trump: 0, bigJoker: 0, smallJoker: 0, S: 0, H: 0, D: 0, C: 0 };
    for (const card of buildDeck()) {
      if (card.rank === 16) actual.bigJoker += 1;
      else if (card.rank === 15) actual.smallJoker += 1;
      if (playSuitOf(card, trumpSuit, rankCard) === 'TRUMP') actual.trump += 1;
      else actual[card.suit] += 1;
    }
    const declared = totalCounts(trumpSuit);
    assert.equal(declared.trump, actual.trump, `主${trumpSuit} 的主牌总数`);
    assert.equal(declared.bigJoker, actual.bigJoker);
    assert.equal(declared.smallJoker, actual.smallJoker);
    for (const s of ['S', 'H', 'D', 'C'].filter(x => x !== trumpSuit)) {
      assert.equal(declared[s], actual[s], `主${trumpSuit} 时 ${s} 的总数`);
    }
  }
});
