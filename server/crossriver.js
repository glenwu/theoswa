import { countTrump, playSuitOf, cardStrength, sortHand, SUITS } from './cards.js';
import { playerBySeat } from './state.js';
import { oppositeSeat } from './rotation.js';

// 三主过河（CROSS_RIVER）纯逻辑：
// 主牌 ≤3 张者可以把主牌全部交给对家（副牌补足 3 张），换回对家 3 张副牌。
// 每队每局最多一次，先点先得；对家副牌不足 3 张时不可发起；对家超时自动挑最小 3 副。

// 当前阶段仍可发起/跳过过河的玩家座位（纯公开信息判定，绝不遍历他人手牌内容——
// 这里只看张数：主牌数、对家副牌数）。
export function crossRiverCandidates(state) {
  const r = state.round;
  if (!r || state.phase !== 'CROSS_RIVER' || !r.trumpSuit) return [];
  const ctx = { trumpSuit: r.trumpSuit, rankCard: r.rankCard };
  const cr = r.crossRiver;
  const out = [];
  for (const p of state.players) {
    if (cr.doneTeams.includes(p.team)) continue;
    if (cr.passedSeats.includes(p.seat)) continue;
    // 同队已有一笔进行中的过河 → 本队其余人不能再发起（先点先得）
    if (cr.active.some(a => a.fromSeat % 2 === p.team)) continue;
    if (countTrump(p.hand, ctx) > 3) continue;
    const partner = playerBySeat(state, oppositeSeat(p.seat));
    if (!partner) continue;
    const partnerSide = partner.hand.filter(c => playSuitOf(c, ctx.trumpSuit, ctx.rankCard) !== 'TRUMP').length;
    if (partnerSide < 3) continue; // 对家副牌不足 3 张 → 过河不可发起
    out.push(p.seat);
  }
  return out;
}

// 发起者的 3 张牌校验：必须恰好 3 张、全部在手上、包含其手上全部主牌（≤3），
// 副牌只作补足。返回 null 表示合法，否则返回错误文案。
export function validateRiverGive(hand, cardIds, trumpSuit, rankCard) {
  if (!Array.isArray(cardIds) || cardIds.length !== 3 || new Set(cardIds).size !== 3) {
    return '必须恰好选择 3 张牌';
  }
  const cards = cardIds.map(id => hand.find(c => c.id === id));
  if (cards.some(c => !c)) return '所选牌不在你手上';
  const myTrumpCount = countTrump(hand, { trumpSuit, rankCard });
  const givenTrumpCount = cards.filter(c => playSuitOf(c, trumpSuit, rankCard) === 'TRUMP').length;
  if (givenTrumpCount !== myTrumpCount) return '必须交出你的全部主牌';
  return null;
}

// 对家回牌校验：必须恰好 3 张、全部在手上、全部是副牌。
export function validateRiverBack(hand, cardIds, trumpSuit, rankCard) {
  if (!Array.isArray(cardIds) || cardIds.length !== 3 || new Set(cardIds).size !== 3) {
    return '必须恰好选择 3 张牌';
  }
  const cards = cardIds.map(id => hand.find(c => c.id === id));
  if (cards.some(c => !c)) return '所选牌不在你手上';
  if (cards.some(c => playSuitOf(c, trumpSuit, rankCard) === 'TRUMP')) return '只能回副牌';
  return null;
}

// 对家超时自动回牌：挑他最小的 3 张副牌（牌力升序；同牌力按花色顺序，确定性）
export function pickLowestSideCards(hand, n, trumpSuit, rankCard) {
  const ctx = { trumpSuit, rankCard };
  const side = hand.filter(c => playSuitOf(c, trumpSuit, rankCard) !== 'TRUMP');
  const cmp = (a, b) =>
    cardStrength(a, ctx) - cardStrength(b, ctx) ||
    SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
  return [...side].sort(cmp).slice(0, n);
}

// 执行一笔过河交换（调用方保证 giveCardIds/backCardIds 已通过校验）：
// - 发起者 giveCardIds（全部主牌 + 副牌补足 3 张）→ 对家
// - 对家 backCardIds（3 张副牌）→ 发起者
// 双方手牌数不变；牌去向表由调用方 relocateTableCards 同步（件表 + 主牌表）。
export function executeCrossRiver(state, active, backCardIds) {
  const r = state.round;
  const ctx = { trumpSuit: r.trumpSuit, rankCard: r.rankCard };
  const from = playerBySeat(state, active.fromSeat);
  const to = playerBySeat(state, active.toSeat);

  const give = active.giveCardIds.map(id => from.hand.find(c => c.id === id));
  const back = backCardIds.map(id => to.hand.find(c => c.id === id));

  from.hand = from.hand.filter(c => !active.giveCardIds.includes(c.id));
  to.hand = to.hand.filter(c => !backCardIds.includes(c.id));
  to.hand.push(...give);
  from.hand.push(...back);
  from.hand = sortHand(from.hand, ctx);
  to.hand = sortHand(to.hand, ctx);

  r.crossRiver.active = r.crossRiver.active.filter(a => a.fromSeat !== active.fromSeat);
  if (!r.crossRiver.doneTeams.includes(from.team)) r.crossRiver.doneTeams.push(from.team);
  if (from.seat === state.declarerSeat) r.declarerCrossedRiver = true;

  // 返回移动明细，供调用方同步件表/主牌表去向
  return [
    ...give.map(c => ({ cardId: c.id, toSeat: to.seat })),
    ...back.map(c => ({ cardId: c.id, toSeat: from.seat })),
  ];
}
