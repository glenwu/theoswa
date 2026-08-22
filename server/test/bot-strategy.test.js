import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseKittyCards, chooseLeadCards } from '../bot-policy.js';
import { buildDeck, playSuitOf } from '../cards.js';
import { mulberry32 } from '../rng.js';

// 真人牌友（Glen）报的问题：电脑做庄压底时会为了「正好 8 张断一门」把副 A 压进底牌。
//
// 这不是打法偏好，是可证明的错误 —— 见 server/pieces.js：
//   handleBuryKitty 把埋进底牌的副 A/K 强制公开亮出；
//   pieceStatusesFor 把 kittyRevealed 记成 'seen'；
//   canThrowByStatus 只要求该门每一件都 !== 'unseen'。
// 所以压副 A 是双重损失：丢掉该门最大的一张，还亲手把对手甩这门的资格凑齐。
// 真人的取舍是「埋 K 不埋 A」：A 自身 0 分、被抓也不送分；K 是 10 分的负债。
//
// 改之前实测 400 手随机庄家牌里有 83 手（20.8%）会压副 A。

const SUITS = ['S', 'H', 'D', 'C'];

// 随机发一手 33 张的庄家牌（25 + 并进来的 8 张底牌）
function dealDeclarerHand(seed) {
  const rng = mulberry32(seed);
  const deck = buildDeck();
  for (let j = deck.length - 1; j > 0; j -= 1) {
    const k = Math.floor(rng() * (j + 1));
    [deck[j], deck[k]] = [deck[k], deck[j]];
  }
  return deck.slice(0, 33);
}

test('埋底：200 手随机庄家牌，一张副 A 都不许压进底牌', () => {
  const offenders = [];
  for (let i = 0; i < 200; i += 1) {
    const trumpSuit = SUITS[i % 4];
    const ctx = { trumpSuit, rankCard: 2 };
    const hand = dealDeclarerHand(1000 + i);
    const buried = chooseKittyCards(hand, ctx);
    const aces = buried.filter(
      c => c.suit !== 'JOKER' && c.suit !== trumpSuit && c.rank === 14 && c.rank !== ctx.rankCard
    );
    if (aces.length > 0) offenders.push(`seed ${1000 + i} 主${trumpSuit}: ${aces.map(c => c.suit + c.rank).join(',')}`);
  }
  assert.deepEqual(offenders, [], `这些局把副 A 压底了：\n${offenders.join('\n')}`);
});

// 反向保护：第一版惩罚写过头，把「埋 K 断门」也一并罚掉了，
// 结果该断的门反而不敢断 —— 断门本来就是靠主牌毙，不指望封锁。
test('埋底：为了断门而埋副 K 仍然允许（别把惩罚用过头）', () => {
  const ctx = { trumpSuit: 'H', rankCard: 2 };
  const C = (suit, rank, i) => ({ id: `${suit}${rank}_${i}`, suit, rank });
  const hand = [
    ...[14, 11, 10, 9, 8, 7, 6, 4].map((r, i) => C('S', r, i)),      // 黑桃 8 张含 ♠A
    ...[16, 15, 14, 13, 12, 11, 10, 9].map((r, i) => C('H', r, i)),  // 8 张主
    ...[13, 12, 11, 10, 9, 8, 5, 3].map((r, i) => C('D', r, i)),     // 方块 8 张含 ♦K
    ...[13, 12, 11, 10, 9, 8, 5, 4, 3].map((r, i) => C('C', r, i)),  // 9 张梅花
  ];
  assert.equal(hand.length, 33);

  const buried = chooseKittyCards(hand, ctx);
  const retainedDiamonds = hand.filter(
    c => c.suit === 'D' && !buried.some(b => b.id === c.id)
  ).length;

  assert.equal(retainedDiamonds, 0, '应当整门埋掉方块（含 ♦K）来断门');
  assert.ok(
    !buried.some(c => c.suit === 'S' && c.rank === 14),
    '但绝不能改成拿 ♠A 去换这个断门'
  );
});

test('埋底：主牌一张都不埋（老规矩，顺带钉住）', () => {
  for (let i = 0; i < 40; i += 1) {
    const trumpSuit = SUITS[i % 4];
    const ctx = { trumpSuit, rankCard: 2 };
    const hand = dealDeclarerHand(5000 + i);
    const buried = chooseKittyCards(hand, ctx);
    assert.equal(buried.length, 8);
    const trumps = buried.filter(c => playSuitOf(c, trumpSuit, ctx.rankCard) === 'TRUMP');
    assert.deepEqual(trumps, [], `seed ${5000 + i} 把主牌埋了：${trumps.map(c => c.suit + c.rank).join(',')}`);
  }
});

// ---- 求件：不能乱求 ----
//
// Glen：「一般件不能乱求，有时候自己的副牌太弱，求了之后反而是帮对手
// 把对方需要的件求出来」。
//
// 机制上他是对的：canThrowByStatus 要求该门每一件都 !== 'unseen'，
// 所以每逼出一件，就是替【还攥着剩下那些件的人】往甩牌资格上推一步。
// 自己一件都没有还去探，三家里两家是对手，平均就是在帮对手。
//
// 改之前 pieceSeekingLead 的条件只有 `unseen >= 2 && 牌够长`，
// 打分还是 `cards.length * 10 - mine * 2` —— 自己件越多探件意愿越低，完全反了。


function probeView() {
  const C = (suit, rank, i) => ({ id: `${suit}${rank}_${i}`, suit, rank });
  return {
    phase: 'PLAYING',
    declarerSeat: 1,
    you: {
      seat: 0,
      team: 0,
      hand: [
        ...[12, 11, 10, 9, 8, 7, 6].map((r, i) => C('S', r, i)), // 黑桃 7 张，一件都没有
        ...[14, 10, 9, 8, 7, 6].map((r, i) => C('D', r, i)),     // 方块 6 张，握着 ♦A
        ...[16, 5, 4].map((r, i) => C('H', r, i)),               // 3 张主
      ],
    },
    players: [0, 1, 2, 3].map(seat => ({ seat, team: seat % 2, handCount: 16 })),
    round: {
      trumpSuit: 'H',
      rankCard: 2,
      kittyCount: 8,
      currentTrick: [],
      trickHistory: [{ trickNo: 1, leadSeat: 1, leadSuit: 'H', plays: [], winnerSeat: 1, points: 0 }],
      piecesView: {
        S: [ // 黑桃 4 件全在别人暗牌里 —— 探它就是纯替别人求件
          { rank: 14, status: 'unseen' }, { rank: 14, status: 'unseen' },
          { rank: 13, status: 'unseen' }, { rank: 13, status: 'unseen' },
        ],
        D: [ // 方块我握着一张 A —— 探它是把剩下的逼出来给【我自己】凑条件
          { rank: 14, status: 'mine' }, { rank: 14, status: 'unseen' },
          { rank: 13, status: 'unseen' }, { rank: 13, status: 'seen' },
        ],
        C: [],
      },
    },
    botDifficulty: 'expert',
    botBeliefs: { players: {} },
  };
}

test('求件：自己无件的长门不去探（那是替对手求件）', () => {
  const lead = chooseLeadCards(probeView())[0];
  assert.notEqual(lead.suit, 'S', '黑桃 4 件全在别人手上，自己一件没有，不该领黑桃探件');
});

test('求件：优先探自己握着件的那门', () => {
  const lead = chooseLeadCards(probeView())[0];
  assert.equal(lead.suit, 'D', '方块握着 ♦A，探它才是给自己凑甩牌条件');
  assert.equal(lead.rank, 6, '探件用该门最小的无分牌');
});
