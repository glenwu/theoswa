import { playSuitOf } from '../../server/cards.js';

// 场上已经打出来的牌的统计 —— 纯公开信息，全部来自 trickHistory + currentTrick。
// 记牌用：还剩几张主没出、大鬼走了几张，直接决定敢不敢甩、能不能保底。
//
// ⚠️ 绝不能把 round.lastTrick 也算进来：它和 trickHistory 的最后一项是【同一个
// 对象】（actions.js 里先 push 进 trickHistory 再赋给 lastTrick），加进来会让
// 刚打完的那一墩整整翻一倍。
//
// 大小鬼本来就是主牌，所以 trump 里【包含】它们，bigJoker / smallJoker 只是细分。
export function playedCounts(round) {
  const out = { trump: 0, bigJoker: 0, smallJoker: 0, S: 0, H: 0, D: 0, C: 0 };
  if (!round) return out;
  const plays = [
    ...(round.trickHistory ?? []).flatMap(trick => trick.plays ?? []),
    ...(round.currentTrick ?? []),
  ];
  for (const play of plays) {
    for (const card of play.cards ?? []) {
      if (card.rank === 16) out.bigJoker += 1;
      else if (card.rank === 15) out.smallJoker += 1;
      if (playSuitOf(card, round.trumpSuit, round.rankCard) === 'TRUMP') out.trump += 1;
      else out[card.suit] += 1;
    }
  }
  return out;
}

// 整副牌里各类的总数，用来显示「已出 / 总数」。
// 两副牌：大小鬼各 2 张；主牌 = 2 大鬼 + 2 小鬼 + 2 主级牌 + 6 副级牌 + 24 张主花色普通牌；
// 每门副牌 = 13 个点数 × 2 − 该门级牌 2 张（级牌升为主牌，不再属于本门）。
export function totalCounts(trumpSuit) {
  return {
    trump: trumpSuit ? 36 : 0,
    bigJoker: 2,
    smallJoker: 2,
    S: 24, H: 24, D: 24, C: 24,
  };
}
