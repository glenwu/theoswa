import { buildDeck, cardPoints, cardStrength, playSuitOf, SUITS } from './cards.js';
import {
  pickAutoCards,
  trickLeader,
  validateFollowPlay,
} from './trick.js';
import { canThrowByStatus } from './pieces.js';

// 电脑玩家只接收 viewerState 返回的本人视角，绝不读取服务端完整 GameState。
// 这一版的目标是“像一个正常牌友”：识别庄闲、不杀队友、会送分/保分、
// 会在开局表示保底能力，并利用公开的件与出牌历史发展/破坏甩牌。

export const BOT_DIFFICULTIES = Object.freeze(['easy', 'normal', 'hard', 'expert']);

// 可进化的只是模糊局面里的权重与门槛。合法性、公开信息边界等规则仍由引擎保证。
// 牌友约定是强先验而非绝对命令：特殊牌型/尾盘可以用更高的局面分数覆盖它。
export const DEFAULT_BOT_TUNING = Object.freeze({
  preserveWeight: 1,
  coverRiskWeight: 1,
  pointExposureWeight: 1,
  pieceProtectionWeight: 1,
  takeoverWeight: 1,
  emptyTrumpPenaltyWeight: 1,
  voidCreationWeight: 1,
  bottomControlWeight: 1,
  conventionPriorWeight: 1,
  leadStrategyPriorWeight: 1,
  earlyThrowMinLength: 4,
  pieceProbeMinLength: 5,
  opponentThreatThreshold: 2,
});

export const BOT_TUNING_BOUNDS = Object.freeze({
  preserveWeight: [0.45, 1.9],
  coverRiskWeight: [0.45, 2.2],
  pointExposureWeight: [0.45, 2.2],
  pieceProtectionWeight: [0.45, 2.2],
  takeoverWeight: [0.45, 1.9],
  emptyTrumpPenaltyWeight: [0.45, 2.2],
  voidCreationWeight: [0.35, 2.2],
  bottomControlWeight: [0.55, 2.1],
  conventionPriorWeight: [0.25, 2.4],
  leadStrategyPriorWeight: [0.35, 2.2],
  earlyThrowMinLength: [3, 7],
  pieceProbeMinLength: [3, 8],
  opponentThreatThreshold: [1, 5],
});

const INTEGER_TUNING_KEYS = new Set([
  'earlyThrowMinLength',
  'pieceProbeMinLength',
  'opponentThreatThreshold',
]);

export function normalizeBotTuning(value = {}) {
  return Object.fromEntries(Object.entries(DEFAULT_BOT_TUNING).map(([key, fallback]) => {
    const [min, max] = BOT_TUNING_BOUNDS[key];
    const numeric = Number(value?.[key]);
    const bounded = Math.min(max, Math.max(min, Number.isFinite(numeric) ? numeric : fallback));
    return [key, INTEGER_TUNING_KEYS.has(key) ? Math.round(bounded) : bounded];
  }));
}

const DIFFICULTY_SETTINGS = Object.freeze({
  // 难度不靠偷看暗牌实现，而是逐级启用公开信息推断、关键控制保留与历史学习。
  easy:   { inference: 0,    controlReserve: 0.25, learning: 0.25, safeOpeningSignal: false, patientTrumpDeclaration: false },
  normal: { inference: 0.65, controlReserve: 0.75, learning: 0.60, safeOpeningSignal: true, patientTrumpDeclaration: true },
  hard:   { inference: 1.00, controlReserve: 1.00, learning: 1.00, safeOpeningSignal: true, patientTrumpDeclaration: true },
  expert: { inference: 1.35, controlReserve: 1.25, learning: 1.00, safeOpeningSignal: true, patientTrumpDeclaration: true },
});

export function normalizeBotDifficulty(value) {
  const aliases = { 1: 'easy', 2: 'normal', 3: 'hard', 4: 'expert' };
  const normalized = aliases[value] ?? String(value ?? 'expert').toLowerCase();
  return BOT_DIFFICULTIES.includes(normalized) ? normalized : 'expert';
}

function strategySettings(view) {
  return DIFFICULTY_SETTINGS[normalizeBotDifficulty(view.botDifficulty)];
}

const BOT_TUNING_CACHE = new WeakMap();

function strategyTuning(view) {
  const source = view?.botTuning;
  if (!source || typeof source !== 'object') return DEFAULT_BOT_TUNING;
  const cached = BOT_TUNING_CACHE.get(source);
  if (cached) return cached;
  const normalized = normalizeBotTuning(source);
  BOT_TUNING_CACHE.set(source, normalized);
  return normalized;
}

function ctxOf(view) {
  return { trumpSuit: view.round.trumpSuit, rankCard: view.round.rankCard };
}

function suitOf(card, ctx) {
  return playSuitOf(card, ctx.trumpSuit, ctx.rankCard);
}

function cardsOfSuit(cards, suit, ctx) {
  return cards.filter(card => suitOf(card, ctx) === suit);
}

function isSidePiece(card, ctx) {
  return (
    card.suit !== 'JOKER' &&
    card.suit !== ctx.trumpSuit &&
    (card.rank === 13 || card.rank === 14) &&
    card.rank !== ctx.rankCard
  );
}

function keepValue(card, ctx) {
  const effectiveSuit = suitOf(card, ctx);
  if (effectiveSuit === 'TRUMP') {
    if (card.rank === 16) return 180;
    if (card.rank === 15) return 160;
    if (card.rank === ctx.rankCard) return card.suit === ctx.trumpSuit ? 150 : 140;
    return 75 + card.rank;
  }
  return card.rank + cardPoints(card) * 3 + (isSidePiece(card, ctx) ? 45 : 0);
}

function lowCards(cards, count, ctx) {
  return [...cards]
    .sort((a, b) => keepValue(a, ctx) - keepValue(b, ctx) || a.id.localeCompare(b.id))
    .slice(0, count);
}

function highCards(cards, count, ctx) {
  return [...cards]
    .sort((a, b) => keepValue(b, ctx) - keepValue(a, ctx) || a.id.localeCompare(b.id))
    .slice(0, count);
}

function pointCards(cards, count, ctx) {
  return [...cards]
    .sort(
      (a, b) =>
        cardPoints(b) - cardPoints(a) ||
        keepValue(a, ctx) - keepValue(b, ctx) ||
        a.id.localeCompare(b.id)
    )
    .slice(0, count);
}

function lowestLead(cards, ctx) {
  return lowCards(cards, 1, ctx)[0] ?? null;
}

function uniqueCardSets(sets) {
  const seen = new Set();
  const out = [];
  for (const cards of sets) {
    if (!Array.isArray(cards) || cards.some(card => !card)) continue;
    const key = cards.map(card => card.id).sort().join('|');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(cards);
  }
  return out;
}

function discardScore(card, ctx) {
  const isTrump = suitOf(card, ctx) === 'TRUMP';
  return (
    (isTrump ? 10_000 : 0) +
    cardPoints(card) * 120 +
    (isSidePiece(card, ctx) ? 500 : 0) +
    (card.rank === 14 ? 220 : 0) +
    cardStrength(card, ctx)
  );
}

function lowestDiscardable(cards, count, ctx) {
  return [...cards]
    .sort((a, b) => discardScore(a, ctx) - discardScore(b, ctx) || a.id.localeCompare(b.id))
    .slice(0, count);
}

// 亮主花色评分只使用自己目前已经摸到的牌。揭牌尚未结束时不能把“还没摸到”
// 错当成真正缺门，因此这里不使用最终手牌的清门奖励。
function trumpSuitScore(hand, rankCard, trumpSuit) {
  const ctx = { trumpSuit, rankCard };
  const trumps = cardsOfSuit(hand, 'TRUMP', ctx);
  const ordinarySuitCards = hand.filter(card => card.suit === trumpSuit && card.rank !== rankCard);
  const control = trumps.reduce((sum, card) => {
    if (card.rank === 16) return sum + 24;
    if (card.rank === 15) return sum + 20;
    if (card.rank === rankCard) return sum + (card.suit === trumpSuit ? 18 : 14);
    if (card.rank >= 13) return sum + 8;
    return sum + 2;
  }, 0);
  const highOrdinary = ordinarySuitCards.filter(card => card.rank >= 13).length;
  const density = hand.length > 0 ? ordinarySuitCards.length / hand.length : 0;
  return trumps.length * 12 + control + ordinarySuitCards.length * 4 + highOrdinary * 5 + density * 40;
}

// 已决定“现在要现”时，从手中所有级牌候选里选最合适的主花色。
export function chooseTrumpCard(hand, rankCard) {
  const candidates = hand.filter(card => card.rank === rankCard);
  if (candidates.length === 0) return null;
  const suits = [...new Set(candidates.map(card => card.suit))];
  const chosenSuit = suits.sort(
    (a, b) => trumpSuitScore(hand, rankCard, b) - trumpSuitScore(hand, rankCard, a) || a.localeCompare(b)
  )[0];
  return candidates.find(card => card.suit === chosenSuit) ?? candidates[0];
}

// 第一局“现牌即做庄”，所以有级牌马上现；后续局庄家已定，现牌只决定主花色，
// 应把当前花色质量与继续等待的机会一起考虑。简单档仍保留原来的即时现牌行为。
export function chooseTrumpDeclaration(view) {
  const hand = view?.you?.hand ?? [];
  const rankCard = view?.round?.rankCard;
  if (!rankCard) return null;
  const candidate = chooseTrumpCard(hand, rankCard);
  if (!candidate) return null;
  if (view.declarerSeat === null) return candidate;
  if (view.botDeclarationMode === 'immediate') return candidate;

  const settings = strategySettings(view);
  if (!settings.patientTrumpDeclaration) return candidate;

  const score = trumpSuitScore(hand, rankCard, candidate.suit);
  const drawnCount = view.round?.drawnCount ?? 0;
  const progress = Math.max(0, Math.min(1, drawnCount / 100));
  const ctx = { trumpSuit: candidate.suit, rankCard };
  const trumps = cardsOfSuit(hand, 'TRUMP', ctx);
  const ordinarySuitCount = hand.filter(
    card => card.suit === candidate.suit && card.rank !== rankCard
  ).length;
  const sameSuitRankCopies = hand.filter(
    card => card.suit === candidate.suit && card.rank === rankCard
  ).length;
  const threshold = 145 - progress * 25;
  const clearlyStrong =
    (ordinarySuitCount >= 4 && trumps.length >= 6) ||
    sameSuitRankCopies >= 2 ||
    score >= threshold;
  const lateAcceptable = drawnCount >= 84 && score >= 95;
  const lastChance = drawnCount >= 96;
  return clearlyStrong || lateAcceptable || lastChance ? candidate : null;
}

// 保底把握不能只看双大鬼：主太短会先被吊空，最后一轮便留不住大鬼。
// 这里把主长、大小鬼、级牌和高主合成连续置信度，不设“双大鬼=必然保底”的硬规则。
export function assessBottomProtection(hand, ctx) {
  const trumps = cardsOfSuit(hand, 'TRUMP', ctx);
  const bigJokers = trumps.filter(card => card.rank === 16).length;
  const smallJokers = trumps.filter(card => card.rank === 15).length;
  const rankCards = trumps.filter(card => card.rank === ctx.rankCard).length;
  const highOrdinaryTrumps = trumps.filter(
    card => card.suit === ctx.trumpSuit && card.rank !== ctx.rankCard && card.rank >= 13
  ).length;
  const shortfall = Math.max(0, 7 - trumps.length);
  const rawConfidence = Math.max(0.05, Math.min(0.95,
    0.08 +
    trumps.length * 0.055 +
    bigJokers * 0.10 +
    smallJokers * 0.06 +
    rankCards * 0.04 +
    highOrdinaryTrumps * 0.02 -
    shortfall * 0.08
  ));
  // 换底时还不知道大鬼在谁手里：没有双大鬼就不能把“主长”误算成绝对保底。
  const controlCeiling = bigJokers >= 2 ? 0.95 : bigJokers === 1 ? 0.72 : 0.55;
  const confidence = Math.min(rawConfidence, controlCeiling);
  return {
    confidence,
    trumpCount: trumps.length,
    bigJokers,
    smallJokers,
    rankCards,
    highOrdinaryTrumps,
  };
}

function sideThrowStructureValue(cards, ctx) {
  let value = 0;
  for (const suit of SUITS.filter(item => item !== ctx.trumpSuit)) {
    const group = cardsOfSuit(cards, suit, ctx);
    const aces = group.filter(card => card.rank === 14).length;
    const kings = group.filter(card => card.rank === 13).length;
    const pieces = aces + kings;
    value += pieces * 35;
    if (aces === 2) value += 700;
    if (kings === 2) value += 650;
    if (pieces >= 3) value += 500;
    if ((aces === 2 && kings >= 1) || (kings === 2 && aces >= 1)) value += 750;
    if (pieces === 4) value += 1000;
    if (pieces > 0 && group.length >= 5) value += pieces * (group.length - 4) * 25;
    if (pieces === 0 && group.length >= 6) value += (group.length - 5) * 15;
  }
  return value;
}

// 埋件（副牌 A/K）的真实代价 —— 原来完全没算，于是「断一门 +320」永远买得起一张副 A，
// 出现真人绝不会做的「为了 8 张断门把 A 压底」。
//
// 关键机制（server/pieces.js）：
//   handleBuryKitty 会把埋进底牌的副 A/K【强制公开亮出】；
//   pieceStatusesFor 把 kittyRevealed 标成 'seen'；
//   canThrowByStatus 只要求该门每一件都 !== 'unseen'。
// 也就是说：只要我手上还留着这门任意一件，它对三家都是 'unseen'，这门就甩不成；
// 一旦把这门的件全埋光，等于我们亲手把对手甩这门的资格条件凑齐了。
//
// 再叠一层牌力差异：同样是件，
//   A —— 该门最大，必赢一墩，自身 0 分，被抓也不送分 → 该留；
//   K —— 10 分的负债，留在手上迟早被主毙走送给对手 → 该埋。
// 所以真人的直觉是「埋 K 不埋 A」。
//
// ⚠️ 强先验而非硬规则：代价给得足够高，正常局面绝不会埋 A，
// 但极端局面（保底把握极高 + 同时藏掉大量分）总分仍可推翻它。
function pieceBurialCost(hand, buried, ctx) {
  const buriedIds = new Set(buried.map(card => card.id));
  const retained = hand.filter(card => !buriedIds.has(card.id));
  let cost = 0;
  for (const suit of SUITS.filter(item => item !== ctx.trumpSuit)) {
    const buriedHere = buried.filter(card => card.suit === suit && isSidePiece(card, ctx));
    if (buriedHere.length === 0) continue;
    // 埋 A：丢掉该门唯一不可能被副牌压过的牌，且亮出后对手少一道坎
    cost += buriedHere.filter(card => card.rank === 14).length * 300;
    // 这门的件被埋光 → 该门对三家解锁甩牌。
    // ⚠️ 只有【这门还没断】时才算损失：留着牌却封锁不住，才会被对手一次甩掉打穿。
    // 已经断门的话本来就靠主牌毙，不指望封锁 —— 埋 K 断门恰恰是真人打法，
    // 不能因为「件被埋光」把它一并罚掉（第一版就罚过头，导致该断的门不敢断了）。
    const stillHasSuit = retained.some(card => card.suit === suit && suitOf(card, ctx) === suit);
    if (!stillHasSuit) continue;
    const retainedHere = retained.filter(card => card.suit === suit && isSidePiece(card, ctx));
    if (retainedHere.length === 0) cost += 260;
  }
  return cost;
}

function kittyPlanScore(hand, buried, ctx) {
  const buriedIds = new Set(buried.map(card => card.id));
  const retained = hand.filter(card => !buriedIds.has(card.id));
  const protection = assessBottomProtection(retained, ctx);
  const burialCost = buried.reduce((sum, card) => {
    const isTrump = suitOf(card, ctx) === 'TRUMP';
    return sum +
      (isTrump ? 10_000 : 0) +
      cardPoints(card) * 18 +
      (card.rank === 14 ? 90 : 0) +
      (isSidePiece(card, ctx) ? 70 : 0) +
      cardStrength(card, ctx);
  }, 0);
  const buriedPoints = buried.reduce((sum, card) => sum + cardPoints(card), 0);
  // 只有主长与控制牌合成的保底把握超过中线，埋分才开始产生正收益。
  const hiddenPointValue = buriedPoints * Math.max(0, protection.confidence - 0.55) * 100;
  const voidValue = SUITS
    .filter(suit => suit !== ctx.trumpSuit)
    .reduce((sum, suit) => {
      const before = cardsOfSuit(hand, suit, ctx).length;
      const after = cardsOfSuit(retained, suit, ctx).length;
      return sum + (before > 0 && after === 0 ? 320 : 0);
    }, 0);
  const unlockCost = pieceBurialCost(hand, buried, ctx);
  return -burialCost - unlockCost + hiddenPointValue + voidValue + sideThrowStructureValue(retained, ctx);
}

function improveKittyPlan(hand, initial, ctx) {
  let best = initial;
  let bestScore = kittyPlanScore(hand, best, ctx);
  for (let pass = 0; pass < 12; pass += 1) {
    const buriedIds = new Set(best.map(card => card.id));
    const retained = hand.filter(card => !buriedIds.has(card.id));
    let next = best;
    let nextScore = bestScore;
    for (let out = 0; out < best.length; out += 1) {
      for (const incoming of retained) {
        const candidate = [...best];
        candidate[out] = incoming;
        const score = kittyPlanScore(hand, candidate, ctx);
        if (score > nextScore + 0.001) {
          next = candidate;
          nextScore = score;
        }
      }
    }
    if (next === best) break;
    best = next;
    bestScore = nextScore;
  }
  return best;
}

// 换底同时比较：保留主长与控制、造缺门、保留成件/长套、以及在足够保底时藏分。
export function chooseKittyCards(hand, ctx) {
  const sideSuits = SUITS.filter(suit => suit !== ctx.trumpSuit);
  const seeds = [lowestDiscardable(hand, 8, ctx), lowCards(hand, 8, ctx)];

  const protection = assessBottomProtection(hand, ctx);
  if (protection.confidence > 0.55) {
    const pointAware = [...hand]
      .sort((a, b) => {
        const score = card =>
          (suitOf(card, ctx) === 'TRUMP' ? 10_000 : 0) +
          keepValue(card, ctx) -
          cardPoints(card) * (protection.confidence - 0.55) * 100;
        return score(a) - score(b) || a.id.localeCompare(b.id);
      })
      .slice(0, 8);
    seeds.push(pointAware);
  }

  for (let mask = 1; mask < (1 << sideSuits.length); mask += 1) {
    const selected = [];
    for (let i = 0; i < sideSuits.length; i += 1) {
      if (!(mask & (1 << i))) continue;
      const group = cardsOfSuit(hand, sideSuits[i], ctx);
      if (group.length === 0) continue;
      selected.push(...group);
    }
    if (selected.length > 8) continue;
    const pickedIds = new Set(selected.map(card => card.id));
    const fill = lowestDiscardable(
      hand.filter(card => !pickedIds.has(card.id)),
      8 - selected.length,
      ctx
    );
    const candidate = [...selected, ...fill];
    if (candidate.length !== 8) continue;
    seeds.push(candidate);
  }
  return seeds
    .filter(candidate => candidate.length === 8 && new Set(candidate.map(card => card.id)).size === 8)
    .map(candidate => improveKittyPlan(hand, candidate, ctx))
    .sort((a, b) => kittyPlanScore(hand, b, ctx) - kittyPlanScore(hand, a, ctx))[0] ?? [];
}

// 过河回牌也尽量清掉自己的一门短副牌，同时不送分/件。
export function chooseCrossRiverResponse(hand, ctx) {
  const sideCards = hand.filter(card => suitOf(card, ctx) !== 'TRUMP');
  let best = lowestDiscardable(sideCards, 3, ctx);
  let bestCost = best.reduce((sum, card) => sum + discardScore(card, ctx), 0);
  for (const suit of SUITS.filter(s => s !== ctx.trumpSuit)) {
    const group = cardsOfSuit(sideCards, suit, ctx);
    if (group.length === 0 || group.length > 3) continue;
    const ids = new Set(group.map(card => card.id));
    const fill = lowestDiscardable(
      sideCards.filter(card => !ids.has(card.id)),
      3 - group.length,
      ctx
    );
    const candidate = [...group, ...fill];
    const cost = candidate.reduce((sum, card) => sum + discardScore(card, ctx), 0) - 120;
    if (candidate.length === 3 && cost < bestCost) {
      best = candidate;
      bestCost = cost;
    }
  }
  return best;
}

function chooseCrossRiverGive(hand, ctx) {
  const trumps = cardsOfSuit(hand, 'TRUMP', ctx);
  const side = hand.filter(card => suitOf(card, ctx) !== 'TRUMP');
  return [...trumps, ...lowestDiscardable(side, 3 - trumps.length, ctx)];
}

function shouldCrossRiver(view, ctx) {
  const you = view.you;
  if (!you.crossRiver?.eligible) return false;
  // 庄家过河后被撬底有额外惩罚，第一版智能策略对庄家保守处理。
  if (you.seat === view.declarerSeat) return false;
  const trumps = cardsOfSuit(you.hand, 'TRUMP', ctx);
  if (trumps.length === 0) return true;
  const hasControl = trumps.some(card => card.rank >= 15 || card.rank === ctx.rankCard);
  return trumps.length <= 2 && !hasControl;
}

function partnerSeatOf(seat) {
  return (seat + 2) % 4;
}

function playedPointTotal(plays) {
  return plays
    .flatMap(play => play.cards)
    .reduce((sum, card) => sum + cardPoints(card), 0);
}

function knownVoidInSuit(view, seat, suit, ctx) {
  return (view.round.trickHistory ?? []).some(trick => {
    if (trick.leadSuit !== suit) return false;
    const play = trick.plays?.find(item => item.seat === seat);
    if (!play) return false;
    const followed = play.cards.filter(card => suitOf(card, ctx) === suit).length;
    return followed < (trick.plays?.[0]?.cards.length ?? 1);
  });
}

function knownFullCards(view) {
  const cards = [
    ...(view.you.hand ?? []),
    ...(view.round.currentTrick ?? []).flatMap(play => play.cards),
    ...(view.round.trickHistory ?? []).flatMap(trick =>
      (trick.plays ?? []).flatMap(play => play.cards)
    ),
    ...(view.round.fallbackRevealed ?? []),
  ];
  return [...new Map(cards.map(card => [card.id, card])).values()];
}

function unseenCopiesOf(view, suit, rank, ctx) {
  if ((rank === 13 || rank === 14) && suitOf({ suit, rank }, ctx) === suit) {
    const pieces = view.round.piecesView?.[suit] ?? [];
    const sameRankPieces = pieces.filter(item => item.rank === rank);
    if (sameRankPieces.length > 0) {
      return sameRankPieces.filter(item => item.status === 'unseen').length;
    }
  }
  const known = knownFullCards(view)
    .filter(card => card.suit === suit && card.rank === rank).length;
  return Math.max(0, 2 - known);
}

// 第三手之后只剩一个对手：用当时的公开信息估算他是否仍可能用分牌低成本吃走本轮。
// 返回的是风险量而不是“认定他手里有牌”，所以不会把未知暗牌当作事实。
function lastSeatPointExposure(view, candidateLeader, candidateCards, ctx) {
  const current = view.round.currentTrick;
  const lead = current[0];
  if (
    current.length !== 2 ||
    lead.cards.length !== 1 ||
    lead.playSuit === 'TRUMP' ||
    candidateLeader?.seat % 2 !== view.you.team
  ) return 0;

  const lastSeat = (view.you.seat + 3) % 4;
  if (lastSeat % 2 === view.you.team || knownVoidInSuit(view, lastSeat, lead.playSuit, ctx)) {
    return 0;
  }

  const leaderCard = candidateLeader.cards?.[0];
  if (!leaderCard || suitOf(leaderCard, ctx) !== lead.playSuit) return 0;
  const exposedPoints = playedPointTotal(current) +
    candidateCards.reduce((sum, card) => sum + cardPoints(card), 0);
  let exposure = 0;
  for (let rank = 2; rank <= 14; rank += 1) {
    const threat = { id: `unknown-${lead.playSuit}-${rank}`, suit: lead.playSuit, rank };
    if (suitOf(threat, ctx) !== lead.playSuit) continue;
    if (cardStrength(threat, ctx) <= cardStrength(leaderCard, ctx)) continue;
    if (unseenCopiesOf(view, lead.playSuit, rank, ctx) <= 0) continue;
    // 不把所有未知大牌风险相加（等于假设最后一家同时拥有它们）。
    // 对手为反超而打出自己的 K/10 也是在交控制，只按小部分即时损失计。
    const potentialLoss = exposedPoints + cardPoints(threat) * 0.25;
    exposure = Math.max(exposure, potentialLoss);
  }
  return exposure;
}

function partnerSideProtocolChoice(view, choices, ctx) {
  const current = view.round.currentTrick;
  if (current.length !== 2) return null;
  const lead = current[0];
  if (
    lead.seat !== partnerSeatOf(view.you.seat) ||
    lead.playSuit === 'TRUMP' ||
    lead.cards.length !== 1
  ) return null;

  const sameSuitChoices = choices.filter(choice =>
    choice.cards.length === 1 && suitOf(choice.cards[0], ctx) === lead.playSuit
  );
  if (sameSuitChoices.length === 0) return null;

  const before = trickLeader(current, ctx);
  const leadCard = lead.cards[0];
  const lastSeat = (view.you.seat + 3) % 4;
  const lastKnownVoid =
    knownVoidInSuit(view, lastSeat, lead.playSuit, ctx) ||
    (view.botBeliefs?.players?.[lastSeat]?.voidSuits ?? []).includes(lead.playSuit);
  let higherUnseen = 0;
  for (let rank = 2; rank <= 14; rank += 1) {
    const candidate = { id: `partner-control-${lead.playSuit}-${rank}`, suit: lead.playSuit, rank };
    if (suitOf(candidate, ctx) !== lead.playSuit) continue;
    if (cardStrength(candidate, ctx) <= cardStrength(leadCard, ctx)) continue;
    higherUnseen += unseenCopiesOf(view, lead.playSuit, rank, ctx);
  }

  // 朋友的大牌在公开信息上已经封住这门：不抢牌权，优先把分走给他。
  // 若已知最后一家断门，则不能把副牌 A 误当成确定大。
  const partnerControlSecure =
    before?.seat === lead.seat &&
    higherUnseen === 0 &&
    !lastKnownVoid;

  // 朋友领小牌是求件；领 5/10/K 更是强烈求 A。
  // 求件指令高于普通走分：即使朋友当前暂时领先，也先把他要的件贡献出来。
  const asksForPiece = cardPoints(leadCard) > 0 || !isSidePiece(leadCard, ctx);
  const pieceContributions = asksForPiece
    ? sameSuitChoices.filter(choice => isSidePiece(choice.cards[0], ctx))
    : [];
  if (pieceContributions.length > 0) {
    return pieceContributions.sort((a, b) =>
      b.cards[0].rank - a.cards[0].rank ||
      Number(b.provisionalLeaderSeat % 2 === view.you.team) -
        Number(a.provisionalLeaderSeat % 2 === view.you.team) ||
      a.preserveCost - b.preserveCost
    )[0];
  }

  if (partnerControlSecure) {
    const pointFeeds = sameSuitChoices.filter(choice =>
      choice.pointValue > 0 && choice.provisionalLeaderSeat === lead.seat
    );
    if (pointFeeds.length > 0) {
      return pointFeeds.sort((a, b) =>
        b.pointValue - a.pointValue ||
        a.pieceCount - b.pieceCount ||
        a.preserveCost - b.preserveCost
      )[0];
    }
  }

  if (!asksForPiece) {
    // 朋友出 A 但已知最后一家断门时，这不是“确定大”，不能走分送给对手杀。
    return sameSuitChoices
      .filter(choice => choice.pointValue === 0)
      .sort((a, b) => a.preserveCost - b.preserveCost)[0] ?? null;
  }
  // 没件可交时仍要回应朋友的表示：第三手尽量用大的无分牌压过第二家，
  // 让最后一家不能随手塞 5/10/K。若真的压不过，就出最大无分牌如实表示自己这门很弱。
  const noPointChoices = sameSuitChoices.filter(choice => choice.pointValue === 0);
  const takeovers = noPointChoices.filter(choice => choice.provisionalLeaderSeat === view.you.seat);
  const pool = takeovers.length > 0 ? takeovers : noPointChoices;
  if (pool.length > 0) {
    return pool.sort((a, b) =>
      cardStrength(b.cards[0], ctx) - cardStrength(a.cards[0], ctx) ||
      a.preserveCost - b.preserveCost
    )[0];
  }

  // 手上只剩分牌也能超过时，先尽力把朋友的分接住。
  return sameSuitChoices
    .filter(choice => choice.provisionalLeaderSeat % 2 === view.you.team)
    .sort((a, b) =>
      cardStrength(b.cards[0], ctx) - cardStrength(a.cards[0], ctx) ||
      a.pointValue - b.pointValue
    )[0] ?? null;
}

// 队友在要什么 —— 帮他求件，但这个信号是【会过期】的。
//
// Glen：「如果判断对家是很想要求件（比如对家是庄）通常要帮助他把件逼出来，
// 当然这个也是动态的，如果对家吃大，然后打其它牌，证明他有其它安排了，
// 这时候就不再帮他求件了」。
//
// ⚠️ 原来这里把队友【整局】的领牌一路累加进 scores，永不过期 ——
// 他早就改打别的门/改吊主了，这边还在死心塌地回他第一门。
// 现在只认他【最近一次】领牌：换门了，之前那门的请求就作废；
// 改吊主了，说明走的是主牌路线，更不该由我去回副牌。
//
// 强弱信号（Glen）：「第一轮求件是需要打 5 以下」——
// 领出 5 以下的小牌是明确的求件请求；领大牌只是普通发展，帮的力度小得多。
function partnerRequest(view, ctx) {
  const partnerSeat = partnerSeatOf(view.you.seat);
  const leads = (view.round?.trickHistory ?? []).filter(trick => trick.leadSeat === partnerSeat);
  const last = leads[leads.length - 1];
  if (!last || last.leadSuit === 'TRUMP') return null;
  if (cardsOfSuit(view.you.hand ?? [], last.leadSuit, ctx).length === 0) return null;
  const cards = last.plays?.[0]?.cards ?? [];
  return {
    suit: last.leadSuit,
    seeking: cards.length > 0 && cards.every(card => card.rank <= 5),
    partnerIsDeclarer: partnerSeat === view.declarerSeat,
  };
}

function pieceContributionContinuationLead(view, ctx) {
  const history = view.round.trickHistory ?? [];
  const last = history[history.length - 1];
  if (!last || last.winnerSeat !== view.you.seat || last.leadSuit === 'TRUMP') return null;
  const plays = last.plays ?? [];
  const lead = plays[0];
  const mine = plays.find(play => play.seat === view.you.seat);
  if (
    !lead ||
    lead.seat !== partnerSeatOf(view.you.seat) ||
    lead.cards.length !== 1 ||
    !mine
  ) return null;

  const leadCard = lead.cards[0];
  const askedForPiece = cardPoints(leadCard) > 0 || !isSidePiece(leadCard, ctx);
  const contributedPiece = mine.cards.some(card =>
    suitOf(card, ctx) === last.leadSuit && isSidePiece(card, ctx)
  );
  if (!askedForPiece || !contributedPiece) return null;

  const remainingPieces = cardsOfSuit(view.you.hand, last.leadSuit, ctx)
    .filter(card => isSidePiece(card, ctx));
  if (remainingPieces.length === 0) return null;
  // 贡献 A 拿到牌权后，通常先用 K 继续求剩下的 A；
  // 若剩下的是第二张 A，则直接续出 A。
  return [...remainingPieces].sort(
    (a, b) => a.rank - b.rank || a.id.localeCompare(b.id)
  )[0];
}

function opponentThreatSuit(view, ctx, tuning = strategyTuning(view)) {
  const scores = new Map();
  for (const trick of view.round.trickHistory ?? []) {
    if (trick.leadSeat % 2 === view.you.team || trick.leadSuit === 'TRUMP') continue;
    const amount = trick.leadType === 'throw' ? 5 : 1;
    scores.set(trick.leadSuit, (scores.get(trick.leadSuit) ?? 0) + amount);
  }
  return [...scores.entries()]
    .filter(([suit, score]) =>
      score >= tuning.opponentThreatThreshold && cardsOfSuit(view.you.hand, suit, ctx).length > 0
    )
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function confirmedFullKillThreat(view, throwCount) {
  return Object.values(view.botBeliefs?.players ?? {}).some(player =>
    player.team !== view.you.team &&
    player.allTrumpConfirmed === true &&
    player.handCount >= throwCount
  );
}

function safeSideThrow(view, ctx, tuning = strategyTuning(view)) {
  const candidates = [];
  for (const suit of SUITS.filter(s => s !== ctx.trumpSuit)) {
    const cards = cardsOfSuit(view.you.hand, suit, ctx);
    const pieces = view.round.piecesView?.[suit];
    if (
      cards.length >= 2 &&
      canThrowByStatus(pieces) &&
      !confirmedFullKillThreat(view, cards.length)
    ) candidates.push(cards);
  }
  if (candidates.length === 0) return null;
  // 中后盘优先把最长的安全花色一次甩出；早盘至少 4 张才值得暴露。
  const worthwhile = candidates.filter(
    cards => view.you.hand.length <= 10 || cards.length >= tuning.earlyThrowMinLength
  );
  return (worthwhile.length ? worthwhile : []).sort((a, b) => b.length - a.length)[0] ?? null;
}

// ============ 保底判定 · 角色 · 牌势（吊主决策的三块地基）============
//
// 以下模型来自真人牌友 Glen 的实战说明，逐条记在这里，改之前先读懂：
//
// 【保底牌】= 能保证最后一轮自己最大。它不是一张固定的牌型表，是【动态阶梯】。
// 主牌强弱阶梯（见 cards.js 的 cardStrength）：
//     大鬼 1000 ×2 > 小鬼 999 ×2 > 主级牌 998 ×2 > 副级牌 997 ×6 > 主花色 900+rank
// 要保证最后一轮最大，就得握住【当前仍未打出的主牌里最高的那一档】，
// 并且比它更高的档【一张都不许还留在别人手上】。同档不算数 —— 同强度先出者大，
// 我不能指望最后一轮由我先出。
//
// 关键是它【随出牌动态变化】：
//   开局什么都没出 → 只有双大鬼才算握住顶档；
//   别人打掉一张大鬼 → 我手里剩的那张大鬼就够保底了，不再需要小鬼、主2；
//   大鬼两张都出完了 → 我有双小鬼就够，以此类推。
//
// ⚠️ 底牌那 8 张对电脑是未知的，一张顶主可能躺在底牌里永远不出现。
// 这里一律把「没见过」当成「可能在别人手上」——宁可低估自己的把握，
// 也绝不能在没保底时误以为有。
//
// 另一半条件是主牌【长度】：光握住最大的一张不够，主太短会先被吊空，
// 撑不到最后一轮。100 张牌四家分，平均每家 9 张主，低于这个数不算保底牌。
const BOTTOM_MIN_TRUMPS = 9;

function playedCardsOf(view) {
  return [
    ...(view.round?.trickHistory ?? []).flatMap(trick =>
      (trick.plays ?? []).flatMap(play => play.cards ?? [])
    ),
    ...(view.round?.currentTrick ?? []).flatMap(play => play.cards ?? []),
  ];
}

export function assessBottomControl(view, ctx) {
  const hand = view.you?.hand ?? [];
  const myTrumps = cardsOfSuit(hand, 'TRUMP', ctx);

  // 把整副牌里的主牌按强度分档，统计每档 total / mine / played
  const tiers = new Map();
  for (const card of buildDeck()) {
    if (suitOf(card, ctx) !== 'TRUMP') continue;
    const key = cardStrength(card, ctx);
    const tier = tiers.get(key) ?? { total: 0, mine: 0, played: 0 };
    tier.total += 1;
    tiers.set(key, tier);
  }
  for (const card of myTrumps) {
    const tier = tiers.get(cardStrength(card, ctx));
    if (tier) tier.mine += 1;
  }
  for (const card of playedCardsOf(view)) {
    if (suitOf(card, ctx) !== 'TRUMP') continue;
    const tier = tiers.get(cardStrength(card, ctx));
    if (tier) tier.played += 1;
  }

  // 从最高档往下走
  let holdsTopTrump = false;
  for (const [, tier] of [...tiers.entries()].sort((a, b) => b[0] - a[0])) {
    const outstanding = tier.total - tier.played - tier.mine; // 别人手上或底牌里
    if (outstanding > 0) break;      // 这一档还有牌没现身 → 我压不死，断了
    if (tier.mine > 0) { holdsTopTrump = true; break; } // 这一档我有，且更高档已出尽
    // outstanding === 0 且我没有 → 这一档全出完了，继续往下看
  }

  return {
    holdsTopTrump,
    trumpCount: myTrumps.length,
    guaranteed: holdsTopTrump && myTrumps.length >= BOTTOM_MIN_TRUMPS,
  };
}

// 场上还有多少张主牌没露面（不含我手上的；底牌里的仍算未知，故偏高）
function outstandingTrumpCount(view, ctx) {
  const total = buildDeck().filter(card => suitOf(card, ctx) === 'TRUMP').length;
  const played = playedCardsOf(view).filter(card => suitOf(card, ctx) === 'TRUMP').length;
  const mine = cardsOfSuit(view.you?.hand ?? [], 'TRUMP', ctx).length;
  return Math.max(0, total - played - mine);
}

// 角色：吊不吊主完全取决于这个（Glen：「没有通用思路，都要看角色和牌势」）
function leadRole(view) {
  const declarerSeat = view.declarerSeat;
  if (declarerSeat === null || declarerSeat === undefined) return 'defender';
  if (view.you.seat === declarerSeat) return 'declarer';
  if (view.you.seat % 2 === declarerSeat % 2) return 'declarerPartner';
  return 'defender';
}

// 庄家最近在走什么路子（队友做庄时要跟着他打）
function declarerLeadStyle(view) {
  const leads = (view.round?.trickHistory ?? []).filter(
    trick => trick.leadSeat === view.declarerSeat
  );
  const last = leads[leads.length - 1];
  if (!last) return null;
  return last.leadSuit === 'TRUMP' ? 'trump' : 'side';
}

// 副牌够不够强 —— 强就该转打副牌，不用死吊主。
// Glen 的定义：件多、够大、容易得分、能甩牌威胁对方。
function hasStrongSideSuit(view, ctx) {
  for (const suit of SUITS.filter(item => item !== ctx.trumpSuit)) {
    const cards = cardsOfSuit(view.you?.hand ?? [], suit, ctx);
    const items = view.round?.piecesView?.[suit] ?? [];
    const mine = items.filter(item => item.status === 'mine').length;
    if (cards.length >= 2 && canThrowByStatus(items)) return true; // 能甩 = 直接威胁
    if (mine >= 2 && cards.length >= 5) return true;               // 件多又够长 = 容易得分
  }
  return false;
}

// 吊主该出哪张 —— 不是「出大牌」和「出小牌」二选一，取决于自己主牌强弱。
//
// ⚠️ 先纠正一个很容易搞错的地方：打 2 时主牌的强弱阶梯是
//       大鬼 > 小鬼 > 主2 > 副2 > 主花色 A > K > Q > …
//    主花色的 A/K/Q 恰恰是主牌里【偏小】的几档，级牌（2）和鬼才是大牌。
//    曾经这里写成「用主花色 A/K/Q 去吊，把鬼和级牌留着保底」，两头不靠：
//    既不是能消耗对手的小牌，也不是能压住场面的大牌。
//
// Glen（真人牌友）的打法：
//   · 弱势主 → 先吊【小牌】。对手想制止你吊主就得用大牌来杀，
//     等于拿你的小牌换他的大牌，是笔划算买卖，而且还有队友配合。
//   · 强势主 → 可以吊 2 甚至吊鬼，求一个【能连续吊主】的局势；
//     对手若用大牌来杀，我方剩下的大牌照样能保底或撬底。
function canSustainTrumpDraw(trumps, ctx, control) {
  // 顶档 = 鬼 + 主级牌 + 副级牌（cardStrength ≥ 997）
  const topTrumps = trumps.filter(card => cardStrength(card, ctx) >= 997).length;
  return control.holdsTopTrump || (trumps.length >= BOTTOM_MIN_TRUMPS && topTrumps >= 3);
}

function drawingTrumpCard(trumps, ctx, control) {
  return canSustainTrumpDraw(trumps, ctx, control)
    ? highCards(trumps, 1, ctx)[0]   // 强势：吊 2 / 吊鬼，求连续吊主
    : lowestLead(trumps, ctx);       // 弱势：吊小牌，逼对手用大牌来杀
}

function pieceSeekingLead(view, ctx, tuning = strategyTuning(view)) {
  const options = [];
  for (const suit of SUITS.filter(s => s !== ctx.trumpSuit)) {
    const cards = cardsOfSuit(view.you.hand, suit, ctx);
    const items = view.round.piecesView?.[suit] ?? [];
    const mine = items.filter(item => item.status === 'mine').length;
    const unseen = items.filter(item => item.status === 'unseen').length;

    // 手上三件、只差一支：出【和缺失那支同点数】的牌去求它。
    //   AAK（差一支 K）→ 打 K：队友若有另一张 K，四件到齐，我立刻能甩这门。
    //   AKK（差一支 A）→ 打 A。
    // ⚠️ 原来这里写死 `card.rank === 13`，无论缺 A 还是缺 K 都出 K ——
    // AKK 的情况（差 A）出 K 求不到那张 A，白丢 10 分。规律是【缺什么打什么】。
    //
    // 分数必须【压过】下面的通用探件分支：三件只差一支时我们确切知道该打哪张，
    // 通用分支只会挑「最小的无分牌」。曾经这里是 100+牌长，被通用分支的
    // 牌长×10 + 件数×30 盖过去（长门时可达 150+），于是这条精确规则形同虚设。
    if (mine >= 3 && unseen === 1) {
      const missingRank = items.find(item => item.status === 'unseen')?.rank;
      const probe = cards.find(
        card => card.rank === missingRank && card.rank !== ctx.rankCard
      );
      if (probe) {
        options.push({ card: probe, score: 300 + cards.length });
        continue; // 这门已有确定打法，不再让通用探件插一脚
      }
    }

    // 探件：只在【自己这门手上有件】时才做。
    //
    // 探件的本质是把这门剩下的件逼出来，而谁手上还攥着件，谁就从中获益：
    // canThrowByStatus 要求该门每一件都 !== 'unseen'，所以每逼出一件，
    // 就是替持有剩下那些件的人往甩牌资格上推一步。
    // 自己一件都没有还去探，三家里有两家是对手 —— 平均下来是在帮对手求件。
    // 真人牌友的判断就是「先看自己这门强不强，件不能乱求」。
    //
    // ⚠️ 原来的条件是 `unseen >= 2 && 牌够长`，完全不看自己有没有件，
    // 打分还是 `cards.length * 10 - mine * 2` —— 自己件越多探件意愿越低，正好反了。
    // 无件长门不再走这条「探件」路线（那本就不是探件，是表示长门），
    // 它仍然由 chooseLeadCards 的 develop-long-side-suit 提案覆盖，只是不再白拿探件的高分。
    if (mine >= 1 && unseen >= 1 && cards.length >= tuning.pieceProbeMinLength) {
      const low = lowestLead(cards.filter(card => cardPoints(card) === 0), ctx) ?? lowestLead(cards, ctx);
      if (low) options.push({ card: low, score: cards.length * 10 + mine * 30 });
    }
  }
  return options.sort((a, b) => b.score - a.score)[0]?.card ?? null;
}

export function chooseLeadCards(view) {
  const hand = view.you.hand ?? [];
  const round = view.round;
  const ctx = ctxOf(view);
  const trumps = cardsOfSuit(hand, 'TRUMP', ctx);
  const nonTrumps = hand.filter(card => suitOf(card, ctx) !== 'TRUMP');
  const opening = (round.trickHistory?.length ?? 0) === 0;
  const isDeclarer = view.you.seat === view.declarerSeat;
  const tuning = strategyTuning(view);
  const proposals = new Map();
  const addProposal = (cards, bonus, reason) => {
    if (!cards?.length) return;
    const key = cards.map(card => card.id).sort().join('|');
    const current = proposals.get(key);
    if (!current) {
      proposals.set(key, { cards, bonus, reasons: [reason] });
    } else {
      current.bonus += bonus;
      current.reasons.push(reason);
    }
  };

  // 任意单张都是合法候选。这是“强先验而非硬规则”的关键：
  // 常规牌理只是给特定候选加分，特殊局面仍能用总分超过它。
  for (const card of hand) addProposal([card], 0, 'legal-single');

  // ============ 吊主决策 ============
  // Glen（真人牌友）的实战说明，改之前先读 assessBottomControl 上面那段注释。
  //
  // 第一层：自己是不是【保底牌】。是 → 吃大不吊，并且用领副牌这个动作
  //         给队友传「我不吊主」的信号（这个游戏没有叫牌，领什么就是信号）。
  // 第二层：不是保底牌 → 看【角色】和【牌势】：
  //   · 我做庄     → 保守，一切以保底为先（保不到底就是输，跑 200 分也没用）
  //   · 队友做庄   → 跟着庄家的路子打：他吊主我吊主，他打副牌我打副牌；
  //                  除非我自己够保底，那就由我主导
  //   · 我是闲家   → 吊不吊主无所谓，哪个点容易得分就打哪
  // 横切一刀：任何角色下，只要自己【副牌够强】（能甩 / 件多且够长）就转打副牌。
  //
  // ⚠️ 原来只有下面这一条开局提案，`opening` 之后整个函数再没有任何主动吊主，
  // 所以电脑「吊一轮就忘了这回事」—— 不是忘了，是压根没写。
  const control = assessBottomControl(view, ctx);
  const strongSide = hasStrongSideSuit(view, ctx);
  const outstandingTrumps = outstandingTrumpCount(view, ctx);
  const role = leadRole(view);

  // 庄家首出：不够保底就先吊主，表示「我自己保不了底」；够保底则从副牌开始发展。
  // 判据从「有没有双大鬼」换成完整的保底判定（补上了主牌长度这一半 ——
  // 双大鬼但只有 5 张主，照样会被吊空，不算保底牌）。
  if (opening && isDeclarer && !control.guaranteed && trumps.length > 0) {
    addProposal(
      [drawingTrumpCard(trumps, ctx, control)],
      900 * tuning.conventionPriorWeight,
      'dealer-opening-trump-signal'
    );
  }

  // 开局之后的持续吊主
  if (!opening && trumps.length > 0 && outstandingTrumps > 0 && !control.guaranteed && !strongSide) {
    const drawBonus =
      role === 'declarer' ? 520                                        // 保底优先，接着吊
      : role === 'declarerPartner' ? (declarerLeadStyle(view) === 'trump' ? 480 : 0) // 跟庄家路子
      : 0;                                                             // 闲家：随便
    if (drawBonus > 0) {
      addProposal(
        [drawingTrumpCard(trumps, ctx, control)],
        drawBonus * tuning.leadStrategyPriorWeight,
        'continue-trump-draw'
      );
    }
  }

  // 已确认有全主对手能全毙最后一手副牌时，甩牌扣底路线在张数守恒下已经断掉。
  // 若自己还有大鬼，先兑现这墩确定牌权，让朋友安全上分，而不是先甩后两墩全输。
  const bigJoker = hand.find(card => card.rank === 16);
  const sideSuitSet = new Set(nonTrumps.map(card => suitOf(card, ctx)));
  if (
    bigJoker &&
    nonTrumps.length > 0 &&
    sideSuitSet.size === 1 &&
    confirmedFullKillThreat(view, nonTrumps.length)
  ) {
    addProposal([bigJoker], 1_000 * tuning.leadStrategyPriorWeight, 'cash-certain-control');
  }

  // 朋友求件后，自己贡献一件并拿到牌权：立即续打同门第二件，
  // 把这个跨墩意图完成，不再退回“长门出最小牌”的普通逻辑。
  const continuationPiece = pieceContributionContinuationLead(view, ctx);
  if (continuationPiece) {
    addProposal(
      [continuationPiece],
      700 * tuning.conventionPriorWeight,
      'continue-contributed-piece'
    );
  }

  const throwCards = safeSideThrow(view, ctx, tuning);
  if (throwCards) addProposal(throwCards, 620 * tuning.leadStrategyPriorWeight, 'safe-side-throw');

  const seekPiece = pieceSeekingLead(view, ctx, tuning);
  if (seekPiece) addProposal([seekPiece], 450 * tuning.leadStrategyPriorWeight, 'seek-piece');

  // 队友最近用一门领牌表示过，取得牌权后把这门送回去 / 帮他把件逼出来。
  // 他打的是 5 以下的小牌 = 明确求件，力度加大；他做庄则更需要帮（Glen）。
  // ⚠️ 已经有 continuationPiece 时不再提这条：续打同门第二件和「回队友这门」
  // 本来就是同一个意图（帮队友求件），而续件知道该打哪一张具体的牌。
  // 两条同时提案会让「回门」的加分叠上 develop-long-side-suit 的 160，
  // 反过来把更精确的续件盖掉。
  const request = continuationPiece ? null : partnerRequest(view, ctx);
  if (request) {
    // 上限压在 safe-side-throw（620）之下：帮队友求件重要，
    // 但不该盖过自己手上已经能甩的那门 —— 那是实打实的分。
    const bonus =
      320 + (request.seeking ? 160 : 0) + (request.partnerIsDeclarer ? 80 : 0);
    addProposal(
      [lowestLead(cardsOfSuit(hand, request.suit, ctx), ctx)],
      bonus * tuning.leadStrategyPriorWeight,
      'return-partner-suit'
    );
  }

  // 对手多次从某门领牌/甩牌，主动打该门来压缩他最后的甩牌张数。
  const threatSuit = opponentThreatSuit(view, ctx, tuning);
  if (threatSuit) {
    addProposal(
      [lowestLead(cardsOfSuit(hand, threatSuit, ctx), ctx)],
      250 * tuning.leadStrategyPriorWeight,
      'attack-opponent-long-suit'
    );
  }

  // 一般领牌从最长副牌的小无分牌出发，而不是全手随便挑最小。
  const sideGroups = SUITS
    .filter(suit => suit !== ctx.trumpSuit)
    .map(suit => cardsOfSuit(hand, suit, ctx))
    .filter(cards => cards.length > 0)
    .sort((a, b) => b.length - a.length);
  if (sideGroups.length > 0) {
    const long = sideGroups[0];
    const lowNoPoint = lowestLead(long.filter(card => cardPoints(card) === 0), ctx);
    addProposal(
      [lowNoPoint ?? lowestLead(long, ctx)],
      160 * tuning.leadStrategyPriorWeight,
      'develop-long-side-suit'
    );
  }

  // 全剩主牌时仍优先留大牌保底/扣底。
  const fallback = lowestLead(nonTrumps.length ? nonTrumps : trumps, ctx);
  if (fallback) addProposal([fallback], 20, 'low-card-fallback');

  const early = hand.length > 8;
  return [...proposals.values()]
    .map(proposal => {
      const pointValue = proposal.cards.reduce((sum, card) => sum + cardPoints(card), 0);
      const preserveCost = proposal.cards.reduce((sum, card) => sum + keepValue(card, ctx), 0);
      const genericScore =
        -preserveCost * 0.25 * tuning.preserveWeight -
        (early ? pointValue * 8 * tuning.pointExposureWeight : 0) +
        (proposal.cards.length > 1 ? proposal.cards.length * 12 : 0);
      return { ...proposal, score: proposal.bonus + genericScore };
    })
    .sort((a, b) =>
      b.score - a.score || a.cards.map(card => card.id).join('|').localeCompare(
        b.cards.map(card => card.id).join('|')
      )
    )[0]?.cards ?? [];
}

function followCandidates(view, ctx) {
  const hand = view.you.hand ?? [];
  const lead = view.round.currentTrick[0];
  const count = lead.cards.length;
  const leadSuitCards = cardsOfSuit(hand, lead.playSuit, ctx);
  const sets = [];

  const selections = (cards, n) => {
    if (n < 0 || cards.length < n) return [];
    if (n === 0) return [[]];
    return uniqueCardSets([
      lowCards(cards, n, ctx),
      highCards(cards, n, ctx),
      pointCards(cards, n, ctx),
    ]);
  };

  if (count === 1) {
    // 单张跟牌把所有合法牌都交给评分器，才能选出“刚好能赢”的那张。
    for (const card of hand) sets.push([card]);
  } else if (leadSuitCards.length >= count) {
    sets.push(...selections(leadSuitCards, count));
  } else if (leadSuitCards.length > 0) {
    const rest = hand.filter(card => !leadSuitCards.includes(card));
    for (const fill of selections(rest, count - leadSuitCards.length)) {
      sets.push([...leadSuitCards, ...fill]);
    }
  } else {
    sets.push(...selections(hand, count));
    const trumps = cardsOfSuit(hand, 'TRUMP', ctx);
    sets.push(...selections(trumps, count));
    // 尽量把一门短牌整组垫完，为后续杀牌制造缺门。
    for (const suit of SUITS.filter(s => s !== ctx.trumpSuit)) {
      const group = cardsOfSuit(hand, suit, ctx);
      if (group.length === 0 || group.length > count) continue;
      const rest = hand.filter(card => !group.includes(card));
      for (const fill of selections(rest, count - group.length)) sets.push([...group, ...fill]);
    }
  }

  sets.push(pickAutoCards(hand, lead, ctx)); // 永远保留一手已验证的合法兜底牌。
  return uniqueCardSets(sets).filter(cards =>
    validateFollowPlay(
      {
        hand,
        leadSuit: lead.playSuit,
        leadCount: count,
        trumpSuit: ctx.trumpSuit,
        rankCard: ctx.rankCard,
      },
      cards.map(card => card.id)
    ).ok
  );
}

function scoreFollow(view, cards, ctx) {
  const round = view.round;
  const you = view.you;
  const current = round.currentTrick;
  const lead = current[0];
  const before = trickLeader(current, ctx);
  const after = trickLeader([...current, { seat: you.seat, cards }], ctx);
  const beforeTeamWinning = before?.seat % 2 === you.team;
  const afterTeamWinning = after?.seat % 2 === you.team;
  const beforePartnerWinning = before?.seat === partnerSeatOf(you.seat);
  const candidatePoints = cards.reduce((sum, card) => sum + cardPoints(card), 0);
  const totalPoints = playedPointTotal(current) + candidatePoints;
  const hasLeadSuit = cardsOfSuit(you.hand, lead.playSuit, ctx).length > 0;
  const allTrump = cards.every(card => suitOf(card, ctx) === 'TRUMP');
  const isKill = lead.playSuit !== 'TRUMP' && !hasLeadSuit && allTrump;
  const lastToAct = current.length === 3;
  const playersBehind = 3 - current.length;
  const early = you.hand.length > 8;
  const settings = strategySettings(view);
  const tuning = strategyTuning(view);
  const learned = (value = 1) => 1 + (value - 1) * settings.learning;
  const pointCaution = learned(view.botProfile?.pointCaution);
  const pieceCaution = learned(view.botProfile?.pieceCaution);
  const overplayCaution = learned(view.botProfile?.overplayCaution);
  const coverCaution = learned(view.botProfile?.coverCaution);
  const controlCaution = learned(view.botProfile?.controlCaution);
  const declarerTeam = view.declarerSeat % 2;
  const learnedBottomWeight = you.team === declarerTeam
    ? view.botProfile?.dealerBottomWeight ?? 1
    : view.botProfile?.defenderBottomWeight ?? 1;
  const bottomWeight = learned(learnedBottomWeight);
  const lastSeatPointRisk = lastSeatPointExposure(view, after, cards, ctx);
  const bigJokers = you.hand.filter(card => card.rank === 16).length;
  const playedBigJokers = cards.filter(card => card.rank === 16).length;
  const spentLastBigJoker = early && playedBigJokers > 0 && bigJokers === playedBigJokers;
  const publiclySafeThirdFeed =
    current.length === 2 &&
    lead.playSuit !== 'TRUMP' &&
    afterTeamWinning &&
    lastSeatPointRisk === 0;
  const guaranteedPartnerControl =
    beforePartnerWinning &&
    lead.playSuit === 'TRUMP' &&
    lead.cards.length === 1 &&
    lead.cards[0].rank === 16;
  let score =
    -cards.reduce((sum, card) => sum + keepValue(card, ctx), 0) *
      0.25 * overplayCaution * tuning.preserveWeight;

  // 大鬼是确定保底的终极控制。早中盘若还有其他合法选择，不能轻率交掉最后一张。
  if (spentLastBigJoker) {
    score -= 360 * settings.controlReserve * controlCaution;
  }

  // 第三手封分：前两手都不大时，若最后的对手仍可能用 10/K 等分牌反超，
  // 提高当前牌面上限；公开记录已证明对手缺门或分牌均已现时风险自然归零。
  score -= lastSeatPointRisk * 24 * settings.inference * coverCaution * tuning.coverRiskWeight;

  // 还有后家时只是“暂时领先”，不能把桌面分当成已经收下。
  if (afterTeamWinning) score += 40 + totalPoints * (lastToAct ? 5 : 1);
  else score -= 30 + totalPoints * 8;

  // 分牌暴露是独立风险：后面还有人未出时，K/10/5 不能因“暂时领先”反而加分。
  if (playersBehind > 0 && candidatePoints > 0) {
    if (publiclySafeThirdFeed || guaranteedPartnerControl) {
      // 只有公开信息已排除最后一家反超时，第三手才可以放心把分送给朋友。
      score += candidatePoints * 6;
    } else {
      score -= candidatePoints * 12 * pointCaution * tuning.pointExposureWeight;
    }
  }

  // 对手用小牌探件/求件时，主动打出 A/K 会直接帮对手消掉一个“未现件”。
  // 这个代价与本轮最后谁赢无关，必须单独高额惩罚。
  const opponentProbe =
    lead.seat % 2 !== you.team &&
    lead.playSuit !== 'TRUMP' &&
    lead.cards.every(card => !isSidePiece(card, ctx));
  if (opponentProbe) {
    const unseenPieces = (round.piecesView?.[lead.playSuit] ?? [])
      .filter(item => item.status === 'unseen').length;
    const donatedPieces = cards.filter(
      card => suitOf(card, ctx) === lead.playSuit && isSidePiece(card, ctx)
    ).length;
    if (unseenPieces > 0 && donatedPieces > 0) {
      score -= donatedPieces * 320 * pieceCaution * tuning.pieceProtectionWeight;
    }
  }

  if (beforeTeamWinning) {
    if (afterTeamWinning) score += 45;
    else score -= 180;
    if (beforePartnerWinning) {
      // 朋友已经领先：送分、不抢牌权、绝不浪费主牌杀朋友。
      // 只有自己是最后一家时才能确定把分送到朋友手上。
      score += candidatePoints * (lastToAct || guaranteedPartnerControl ? 12 : 1);
      if (isKill) score -= 260;
      if (after?.seat === you.seat) score -= 15;
    }
  } else if (afterTeamWinning) {
    // 对手领先：有分时用“刚好能赢”的牌去抢，无分时早盘少浪费主牌。
    score += (100 + totalPoints * (lastToAct ? 10 : 2) + (lastToAct ? 45 : 0)) *
      tuning.takeoverWeight;
    if (isKill && totalPoints === 0 && early) score -= 180 * tuning.emptyTrumpPenaltyWeight;
  } else {
    // 已经无法赢下这轮，不往对手那里送分。
    score -= candidatePoints * 14;
    if (isKill) score -= 120;
  }

  // 垫完一门短牌可以制造缺门，之后才有杀牌机会。
  if (!isKill) {
    const selected = new Set(cards.map(card => card.id));
    for (const suit of SUITS.filter(s => s !== ctx.trumpSuit)) {
      const group = cardsOfSuit(you.hand, suit, ctx);
      if (group.length > 0 && group.every(card => selected.has(card.id))) {
        score += 18 * tuning.voidCreationWeight;
      }
    }
  }

  // 尾盘底牌优先级远高于普通分数：争取倒数第二轮牌权，保留最后控制牌。
  const selected = new Set(cards.map(card => card.id));
  const remaining = you.hand.filter(card => !selected.has(card.id));
  if (remaining.length <= lead.cards.length) {
    score += (afterTeamWinning ? 240 : -240) * bottomWeight * tuning.bottomControlWeight;
    const remainingControl = remaining.reduce(
      (best, card) => Math.max(best, keepValue(card, ctx)),
      0
    );
    score += remainingControl * 0.35 * bottomWeight * tuning.bottomControlWeight;
  } else if (remaining.length <= lead.cards.length * 2) {
    // 倒数第二轮争牌权常常决定最后谁先出；保底失败/扣底失败后会逐步提高此项权重。
    score += (afterTeamWinning ? 80 : -80) * bottomWeight * tuning.bottomControlWeight;
  }

  return { score, lastSeatPointRisk, spentLastBigJoker };
}

// 局末复盘用：候选牌及评分全部来自出牌当时的 viewerState，
// 不接触其他玩家的隐藏手牌。
export function evaluateFollowChoices(view) {
  const ctx = ctxOf(view);
  return followCandidates(view, ctx).map(cards => {
    const leader = trickLeader(
      [...view.round.currentTrick, { seat: view.you.seat, cards }],
      ctx
    );
    const evaluation = scoreFollow(view, cards, ctx);
    return {
      cards,
      score: evaluation.score,
      lastSeatPointRisk: evaluation.lastSeatPointRisk,
      spentLastBigJoker: evaluation.spentLastBigJoker,
      provisionalLeaderSeat: leader?.seat ?? null,
      pointValue: cards.reduce((sum, card) => sum + cardPoints(card), 0),
      pieceCount: cards.filter(card => isSidePiece(card, ctx)).length,
      preserveCost: cards.reduce((sum, card) => sum + keepValue(card, ctx), 0),
    };
  });
}

export function chooseFollowCards(view) {
  const ctx = ctxOf(view);
  const round = view.round;
  const lead = round.currentTrick[0];
  const choices = evaluateFollowChoices(view);
  if (choices.length === 0) return [];
  const tuning = strategyTuning(view);
  const priorBonus = new Map(choices.map(choice => [choice, 0]));

  // 开局庄家吊主是在询问朋友的保底能力；朋友打大不是单纯“亮一张大牌”，
  // 而是要先把当前牌权争过来，才能在下一轮领牌表达自己的牌型。
  const openingAsk =
    (round.trickHistory?.length ?? 0) === 0 &&
    lead.seat === view.declarerSeat &&
    lead.playSuit === 'TRUMP' &&
    lead.cards.length === 1 &&
    lead.cards.every(card => card.rank !== 16) &&
    view.you.seat === partnerSeatOf(view.declarerSeat);
  if (openingAsk) {
    const allLeadSuit = choices.filter(choice =>
      choice.cards.every(card => suitOf(card, ctx) === 'TRUMP')
    );
    if (allLeadSuit.length > 0) {
      const settings = strategySettings(view);
      if (!settings.safeOpeningSignal) {
        return allLeadSuit.sort(
          (a, b) =>
            b.preserveCost - a.preserveCost
        )[0].cards;
      }

      // 庄家朋友的标准表示区间：主 A 及其以上、但严格低于小鬼。
      // 先筛出能立即取得当前领先的牌，再用其中最小的一张；这既争到了下一轮
      // 的表示机会，也不会为了“表示”多浪费更高控制。大小鬼仍留作保底。
      const trumpAceStrength = ctx.rankCard === 14
        ? 997 // 打 A 时副级 A 也属于“A 以上”的表示区间。
        : cardStrength({ id: 'signal-threshold', suit: ctx.trumpSuit, rank: 14 }, ctx);
      const nonJokers = allLeadSuit.filter(choice =>
        choice.cards.every(card => card.rank < 15)
      );
      const signalCards = nonJokers.filter(choice =>
        choice.cards.every(card => cardStrength(card, ctx) >= trumpAceStrength)
      );
      const takeoverCards = signalCards.filter(choice =>
        choice.provisionalLeaderSeat === view.you.seat
      );
      const pool = takeoverCards.length > 0
        ? takeoverCards
        : nonJokers.length > 0
          ? nonJokers // 安全区间无法夺权时不空耗大主，出小主表示主弱/本轮争不到。
          : allLeadSuit; // 只剩鬼时才被迫动最小的一张。
      const preferred = pool.sort(
        (a, b) => a.preserveCost - b.preserveCost
      )[0];
      // “主 A 以上、小鬼以下”是强先验，但不是不可越过的 if-return。
      // 尾盘、特殊牌型或不同的学习权重仍可以选择其他合法牌。
      priorBonus.set(preferred, (priorBonus.get(preferred) ?? 0) + 700 * tuning.conventionPriorWeight);
    }
  }

  // 副牌的对家配合是比通用“保大牌/保分”评分更高一层的出牌语义。
  // easy 档保留机械出牌；normal 以上才识别求件、第三手封门和安全走分。
  if (strategySettings(view).inference > 0) {
    const partnerProtocol = partnerSideProtocolChoice(view, choices, ctx);
    if (partnerProtocol) {
      priorBonus.set(
        partnerProtocol,
        (priorBonus.get(partnerProtocol) ?? 0) + 700 * tuning.conventionPriorWeight
      );
    }
  }

  return choices
    .sort((a, b) =>
      (b.score + (priorBonus.get(b) ?? 0)) - (a.score + (priorBonus.get(a) ?? 0)) ||
      a.cards[0].id.localeCompare(b.cards[0].id)
    )[0].cards;
}

export function choosePlayCards(view) {
  return view.round.currentTrick.length === 0
    ? chooseLeadCards(view)
    : chooseFollowCards(view);
}

// 返回一个玩家意图；是否由电脑控制由 BotController 在外层判断。
export function decideBotAction(view) {
  if (!view?.you) return null;
  const you = view.you;
  const round = view.round;

  if (view.resetProposal && !view.resetProposal.yesSeats.includes(you.seat)) {
    return { type: 'voteReset', agree: true };
  }

  if (view.phase === 'SEATING' && !you.seatLocked) {
    return { type: 'confirmSeat' };
  }
  if (view.phase === 'READY_CHECK' && !you.ready) {
    return { type: 'ready' };
  }
  if (view.phase === 'REVEAL_FIRST' && view.flipperSeat === null) {
    return { type: 'claimFlipper' };
  }
  if (view.phase === 'REVEALING' && round && !round.trumpSuit) {
    const trump = chooseTrumpDeclaration(view);
    if (trump) return { type: 'declareTrump', cardId: trump.id };
    if (round.drawnCount < 100 && round.revealTurnSeat === you.seat) {
      return { type: 'drawCard' };
    }
  }
  if (view.phase === 'KITTY_EXCHANGE' && view.declarerSeat === you.seat && round) {
    const cards = chooseKittyCards(you.hand ?? [], ctxOf(view));
    if (cards.length === 8) return { type: 'buryKitty', cardIds: cards.map(card => card.id) };
  }
  if (view.phase === 'CROSS_RIVER' && round) {
    const ctx = ctxOf(view);
    if (you.crossRiver?.mustRespond) {
      const cards = chooseCrossRiverResponse(you.hand ?? [], ctx);
      if (cards.length === 3) {
        return { type: 'respondCrossRiver', cardIds: cards.map(card => card.id) };
      }
    }
    if (shouldCrossRiver(view, ctx)) {
      const cards = chooseCrossRiverGive(you.hand ?? [], ctx);
      if (cards.length === 3) {
        return { type: 'initiateCrossRiver', cardIds: cards.map(card => card.id) };
      }
    }
    if (you.crossRiver?.eligible) return { type: 'skipCrossRiver' };
  }
  if (
    view.phase === 'PLAYING' &&
    round &&
    !round.lastTrick &&
    round.turnSeat === you.seat
  ) {
    const cards = choosePlayCards(view);
    if (cards.length > 0) return { type: 'play', cardIds: cards.map(card => card.id) };
  }
  // 起揭人停留：电脑直接确认，否则三个电脑不点，真人每局都得干等满 10 秒。
  if (view.phase === 'REVEAL_FIRST' && round?.flipDone && !(round.flipConfirms ?? []).includes(you.seat)) {
    return { type: 'confirmFlip' };
  }
  // 本局小结：电脑直接确认。否则三个电脑不点，真人每局都得干等满 100 秒。
  if (view.phase === 'ROUND_END' && round && !(round.roundEndConfirms ?? []).includes(you.seat)) {
    return { type: 'confirmRoundEnd' };
  }
  if (view.phase === 'DOMINANCE' && round?.dominance) {
    return { type: 'confirmDominance' };
  }
  return null;
}
