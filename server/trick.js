import { playSuitOf, cardStrength, cardPoints } from './cards.js';
import { SUIT_NAMES } from './constants.js';
import { canThrowByStatus, missingPieceLabels } from './pieces.js';

// 出牌与一轮结算的纯函数（不依赖 DOM/网络/全局状态）。
// 校验函数接收纯参数（hand/piecesView/trumpSuit/rankCard），
// 服务端与前端共用同一份实现：前端只用于按钮禁用与提示，服务端仍是唯一权威。

export const TrickError = {
  EMPTY_SELECTION: 'EMPTY_SELECTION',
  DUPLICATE_CARD_ID: 'DUPLICATE_CARD_ID',
  CARDS_NOT_IN_HAND: 'CARDS_NOT_IN_HAND',
  THROW_MIXED_SUIT: 'THROW_MIXED_SUIT',
  THROW_NOT_ELIGIBLE: 'THROW_NOT_ELIGIBLE',
  MUST_FOLLOW_SUIT: 'MUST_FOLLOW_SUIT',
  NOT_ENOUGH_SUIT: 'NOT_ENOUGH_SUIT',
  WRONG_COUNT: 'WRONG_COUNT',
};

function resolveCards(hand, ids) {
  if (!Array.isArray(ids) || ids.length === 0) {
    return { error: TrickError.EMPTY_SELECTION, reason: '请选择要出的牌' };
  }
  if (new Set(ids).size !== ids.length) {
    return { error: TrickError.DUPLICATE_CARD_ID, reason: '重复选择了同一张牌' };
  }
  const cards = ids.map(id => hand.find(c => c.id === id));
  if (cards.some(c => !c)) {
    return { error: TrickError.CARDS_NOT_IN_HAND, reason: '所选牌不在你手上' };
  }
  return { cards };
}

// 首家出牌：
// - 单张：任何牌都合法，N=1 不走甩牌判定；
// - 副牌甩牌：同花色 ≥2 张，资格由件状态表判定（canThrowByStatus），不成立提前拒绝；
// - 主牌甩牌：同为 TRUMP ≥2 张即放行（kind='trumpThrow'）——资格判定不在本函数内：
//   按规则要求“不给提示、不提前拒绝”，由服务端在出牌时裁决（算错收缩为最小一张），
//   客户端按钮不禁用、面板不显示主牌行。
export function validateLeadPlay({ hand, piecesView, trumpSuit, rankCard }, cardIds) {
  const resolved = resolveCards(hand, cardIds);
  if (resolved.error) return { ok: false, ...resolved };
  const cards = resolved.cards;

  if (cards.length === 1) {
    return { ok: true, kind: 'single', playSuit: playSuitOf(cards[0], trumpSuit, rankCard) };
  }

  const suits = new Set(cards.map(c => playSuitOf(c, trumpSuit, rankCard)));
  if (suits.size !== 1) {
    return { ok: false, error: TrickError.THROW_MIXED_SUIT, reason: '甩牌必须是同一花色' };
  }
  const suit = [...suits][0];
  if (suit === 'TRUMP') {
    return { ok: true, kind: 'trumpThrow', playSuit: 'TRUMP' };
  }
  const items = piecesView ? piecesView[suit] : undefined;
  if (!canThrowByStatus(items)) {
    const missing = missingPieceLabels(suit, items);
    return {
      ok: false,
      error: TrickError.THROW_NOT_ELIGIBLE,
      reason: `甩牌不成立，还差 ${missing.join('、')}`,
    };
  }
  return { ok: true, kind: 'throw', playSuit: suit };
}

// 跟牌（不对称规则：甩牌者能留牌，跟牌者不能）：
// - 张数必须等于首家张数 N；
// - 持有该花色 ≥N → 必须全部出该花色（自选 N 张）；
// - 持有 1..N-1 → 该花色全部打出，一张不许留，其余补齐（补齐牌不比大小）；
// - 持有 0 → 任意 N 张合法（出满 N 张主牌为“杀”，其余为垫）。
export function validateFollowPlay({ hand, leadSuit, leadCount, trumpSuit, rankCard }, cardIds) {
  const resolved = resolveCards(hand, cardIds);
  if (resolved.error) return { ok: false, ...resolved };
  const cards = resolved.cards;
  const N = leadCount;
  if (cards.length !== N) {
    return { ok: false, error: TrickError.WRONG_COUNT, reason: `本轮必须出 ${N} 张牌` };
  }

  const suitName = leadSuit === 'TRUMP' ? '主牌' : SUIT_NAMES[leadSuit];
  const mySuitCount = hand.filter(c => playSuitOf(c, trumpSuit, rankCard) === leadSuit).length;
  const playedSuitCount = cards.filter(c => playSuitOf(c, trumpSuit, rankCard) === leadSuit).length;

  if (mySuitCount >= N) {
    if (playedSuitCount !== N) {
      return { ok: false, error: TrickError.MUST_FOLLOW_SUIT, reason: `必须跟${suitName}` };
    }
  } else if (mySuitCount > 0) {
    if (playedSuitCount !== mySuitCount) {
      return {
        ok: false,
        error: TrickError.NOT_ENOUGH_SUIT,
        reason: `${suitName}不够，需垫 ${N - mySuitCount} 张其他牌`,
      };
    }
  }
  // 0 张该花色：任意 N 张合法（主牌杀 / 垫牌在 resolveTrick 中区分）
  return { ok: true };
}

function maxStrength(cards, ctx) {
  let best = -Infinity;
  for (const c of cards) best = Math.max(best, cardStrength(c, ctx));
  return best;
}

// 一轮结算。用“严格大于才替换赢家”实现先出者大——
// 平局（副级牌之间、两张同点同花色）自然归先出者，不依赖 Array.sort 的稳定性。
//
// 分支 A（首家出副牌花色 S）：
//   1. 出满 N 张 S 者参与比较，比各自最大一张；
//   2. 出满 N 张主牌者算“杀”，杀 > 任何 S；
//   3. 多家都杀 → 杀者之间比各自最大的主牌；
//   4. 补齐牌、不足 N 张的主牌一律不参与比较。
// 分支 B（首家出主牌）：不存在“杀”，满额跟出主牌者比最大主牌，仅此而已。
//
// trickLeader 支持“部分已出牌”（1..4 手），用于 UI 实时高亮当前牌面最大者；
// resolveTrick 基于同一套判定逻辑，两者永远一致。
export function trickLeader(plays, ctx) {
  if (!Array.isArray(plays) || plays.length === 0) return null;
  const lead = plays[0];
  const leadSuit = lead.playSuit ?? playSuitOf(lead.cards[0], ctx.trumpSuit, ctx.rankCard);
  const N = lead.cards.length;

  let winner = lead;
  let winnerKey = maxStrength(lead.cards, ctx);
  let winnerIsKill = leadSuit === 'TRUMP'; // 主牌局没有“杀”概念，首家即基准

  for (const play of plays.slice(1)) {
    if (leadSuit === 'TRUMP') {
      // 分支 B：跟主牌，满额跟出者比最大主牌，垫牌不参与
      const trumps = play.cards.filter(c => playSuitOf(c, ctx.trumpSuit, ctx.rankCard) === 'TRUMP');
      if (trumps.length < N) continue;
      const max = maxStrength(trumps, ctx);
      if (max > winnerKey) {
        winner = play;
        winnerKey = max;
      }
    } else {
      // 分支 A：首家出副牌花色
      const suitCards = play.cards.filter(c => playSuitOf(c, ctx.trumpSuit, ctx.rankCard) === leadSuit);
      if (suitCards.length === N) {
        const max = maxStrength(suitCards, ctx);
        if (!winnerIsKill && max > winnerKey) {
          winner = play;
          winnerKey = max;
        }
      } else if (suitCards.length === 0) {
        const trumps = play.cards.filter(c => playSuitOf(c, ctx.trumpSuit, ctx.rankCard) === 'TRUMP');
        if (trumps.length === N) {
          // 出满 N 张主牌 = 杀
          const max = maxStrength(trumps, ctx);
          if (!winnerIsKill || max > winnerKey) {
            winner = play;
            winnerKey = max;
            winnerIsKill = true;
          }
        }
        // 不足 N 张主牌的垫牌不参与
      }
      // 补齐牌（suitCards 介于 0 与 N 之间）不参与比较
    }
  }
  return winner;
}

export function resolveTrick(plays, ctx) {
  if (!Array.isArray(plays) || plays.length !== 4) {
    throw new Error('resolveTrick：需要四家出齐');
  }
  const winner = trickLeader(plays, ctx);
  const points = plays.flatMap(p => p.cards).reduce((sum, c) => sum + cardPoints(c), 0);
  return { winnerSeat: winner.seat, points };
}

// 不变量：每轮结束后四家手牌数必须相等（跟牌张数校验的兜底防线）
export function assertEqualHandCounts(players) {
  const counts = players.map(p => p.hand.length);
  if (new Set(counts).size !== 1) {
    throw new Error(`手牌数不变量被破坏：${counts.join(',')}`);
  }
}

// 出牌超时的自动选择：一手合法且尽量小的牌。
// 首家出最小单张（优先非主牌）；跟牌按规则（有花色出满 N / 不够全出补齐 /
// 无花色 N 张主牌杀 / 否则垫最小 N 张）。
export function pickAutoCards(hand, lead, ctx) {
  const suitOf = c => playSuitOf(c, ctx.trumpSuit, ctx.rankCard);
  const bySuit = s => hand.filter(c => suitOf(c) === s);
  const lowest = (cards, n) =>
    [...cards].sort((a, b) => cardStrength(a, ctx) - cardStrength(b, ctx)).slice(0, n);

  if (!lead) {
    const nonTrump = hand.filter(c => suitOf(c) !== 'TRUMP');
    return [lowest(nonTrump.length ? nonTrump : hand, 1)[0]];
  }
  const N = lead.cards.length;
  const suitCards = bySuit(lead.playSuit);
  if (suitCards.length >= N) return lowest(suitCards, N);
  if (suitCards.length > 0) {
    return [
      ...lowest(suitCards, suitCards.length),
      ...lowest(hand.filter(c => !suitCards.includes(c)), N - suitCards.length),
    ];
  }
  const trumps = bySuit('TRUMP');
  if (trumps.length >= N) return lowest(trumps, N); // 杀
  return lowest(hand, N); // 垫
}
