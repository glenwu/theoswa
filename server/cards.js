import { SUIT_NAMES } from './constants.js';

// 牌组与牌力纯函数。
// 本游戏没有对子、没有拖拉机：两张同点同花色的牌只是两张独立单牌。

export const SUITS = Object.freeze(['S', 'H', 'D', 'C']);
export const SUIT_SYMBOL = Object.freeze({ S: '♠', H: '♥', D: '♦', C: '♣' });
const SUIT_ORDER = { S: 0, H: 1, D: 2, C: 3 };

// rank: 2..10 点数，11=J 12=Q 13=K 14=A，15=小王，16=大王
export function rankLabel(rank) {
  if (rank === 11) return 'J';
  if (rank === 12) return 'Q';
  if (rank === 13) return 'K';
  if (rank === 14) return 'A';
  return String(rank);
}

export function cardLabel(card) {
  if (card.suit === 'JOKER') return card.rank === 16 ? '大鬼' : '小鬼';
  return `${SUIT_NAMES[card.suit]}${rankLabel(card.rank)}`;
}

// 两副牌共 108 张（含大小王各 2 张），每张 id 唯一
export function buildDeck() {
  const deck = [];
  let n = 0;
  for (let copy = 0; copy < 2; copy++) {
    for (const suit of SUITS) {
      for (let rank = 2; rank <= 14; rank++) {
        deck.push({ id: `c${n++}`, suit, rank });
      }
    }
    deck.push({ id: `c${n++}`, suit: 'JOKER', rank: 15 }); // 小王
    deck.push({ id: `c${n++}`, suit: 'JOKER', rank: 16 }); // 大王
  }
  return deck;
}

// 从牌堆末尾分离 8 张底牌（原地修改 deck，返回底牌）
export function separateKitty(deck) {
  return deck.splice(deck.length - 8, 8);
}

// 分数牌：5=5分，10=10分，K=10分；全场总分 200
export function cardPoints(card) {
  if (card.rank === 5) return 5;
  if (card.rank === 10 || card.rank === 13) return 10;
  return 0;
}

export function isRankCard(card, rankCard) {
  return card.rank === rankCard;
}

// 有效花色（阶段2的 sortHand 依赖，阶段3的跟牌校验大量调用，务必写对）：
// 大小王、主级牌、副级牌、主花色牌 —— 均属于主牌（TRUMP）。
// 副级牌属于主牌，不属于它原本的花色（例：打2主红桃时，♠2 不是黑桃）。
export function playSuitOf(card, trumpSuit, rankCard) {
  if (card.suit === 'JOKER') return 'TRUMP';
  if (card.rank === rankCard) return 'TRUMP'; // 主级牌 + 副级牌
  if (card.suit === trumpSuit) return 'TRUMP';
  return card.suit; // 副牌
}

// 牌力（从大到小）：
// 大王 > 小王 > 主级牌 > 副级牌 > 主花色 A..3 > 副牌各花色内部 A..3
// 副级牌之间互不比大小（同为副级牌时先出者大）；
// 两张完全相同的牌相遇时先出者大 —— 两者都由 compareCards 返回 0 表达。
export function cardStrength(card, { trumpSuit, rankCard }) {
  if (card.rank === 16) return 1000; // 大王
  if (card.rank === 15) return 999; // 小王
  if (card.rank === rankCard) return card.suit === trumpSuit ? 998 : 997; // 主级牌 / 副级牌
  if (card.suit === trumpSuit || card.suit === 'JOKER') return 900 + card.rank; // 主花色普通牌
  return card.rank; // 副牌（花色内部比较；跨花色比较无意义，由出牌逻辑限定）
}

// 返回 -1 / 0 / 1。返回 0 表示同强度 → 先出者大（由出牌顺序判定）。
export function compareCards(a, b, ctx) {
  const sa = cardStrength(a, ctx);
  const sb = cardStrength(b, ctx);
  if (sa !== sb) return sa > sb ? 1 : -1;
  return 0;
}

// 副牌花色组的排列顺序：相邻两组颜色必须不同（红黑交替）。
// 去掉主牌花色后剩 3 门、至多 2 门同色 → 多数色放两端、少数色居中。
// 例：主牌 ♣ 时剩 ♠♥♦（黑红红）→ ♥♠♦；主牌 ♥ 时剩 ♠♦♣（黑红黑）→ ♠♦♣。
export function alternatingSuitOrder(trumpSuit) {
  const remaining = SUITS.filter(s => s !== trumpSuit);
  const red = remaining.filter(s => s === 'H' || s === 'D').sort((a, b) => SUIT_ORDER[a] - SUIT_ORDER[b]);
  const black = remaining.filter(s => s !== 'H' && s !== 'D').sort((a, b) => SUIT_ORDER[a] - SUIT_ORDER[b]);
  if (red.length >= black.length) {
    return black.length > 0 ? [red[0], black[0], red[1]] : red;
  }
  return red.length > 0 ? [black[0], red[0], black[1]] : black;
}

// 手牌自动排序：主牌组最左（大王→小王→主级牌→副级牌→主花色 A..3），
// 副牌按红黑交替顺序分组，组内 A..3 降序。
// 主牌组与副牌组之间的间隔由调用方用 countTrump 计算。
export function sortHand(hand, ctx) {
  const groups = { TRUMP: [] };
  for (const s of SUITS) if (s !== ctx.trumpSuit) groups[s] = [];

  for (const card of hand) {
    const key = playSuitOf(card, ctx.trumpSuit, ctx.rankCard);
    groups[key].push(card);
  }

  const cmp = (a, b) => {
    const d = cardStrength(b, ctx) - cardStrength(a, ctx);
    if (d !== 0) return d;
    // 同强度（如副级牌不同花色）按花色稳定排序，保证确定性
    return (SUIT_ORDER[a.suit] ?? 9) - (SUIT_ORDER[b.suit] ?? 9);
  };

  const out = [];
  groups.TRUMP.sort(cmp);
  out.push(...groups.TRUMP);
  for (const s of alternatingSuitOrder(ctx.trumpSuit)) {
    groups[s].sort(cmp);
    out.push(...groups[s]);
  }
  return out;
}

// 主牌张数：UI 用它确定主牌组与副牌组之间的间隔位置
export function countTrump(hand, ctx) {
  let n = 0;
  for (const card of hand) {
    if (playSuitOf(card, ctx.trumpSuit, ctx.rankCard) === 'TRUMP') n += 1;
  }
  return n;
}
