import { buildDeck, cardPoints, cardStrength, playSuitOf, SUITS } from './cards.js';
import {
  pickAutoCards,
  trickLeader,
  validateFollowPlay,
} from './trick.js';
import { canThrowByStatus } from './pieces.js';
import { DEFENDER_TARGET_POINTS } from './scoring.js';

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
  // 策略是「吃分为主」时，亮件的代价打几折。Glen：「如果是闲家，吃的概率应该得更大，
  // 因为自己的策略就以吃分为主」，同时又说这块「没有一定对错，是概率性的问题」——
  // 所以这里只定结构，量级交给 train-bots 去搜。
  pointsFirstPieceWeight: 0.85,
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
  pointsFirstPieceWeight: [0.4, 1],
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
  // 副牌：点数 + 分值 + 件加成。
  //
  // ⚠️ 这里算出来的顺序是「副A(59) < 副K(88)」，看着是反的 —— K 自带 10 分，
  // 被 points*3 抬到了 A 之上，而 A 才是这门的老大、才是牵制对手的那张。
  // 【但不要顺手去"修"它】，已经推演过一遍：
  //   · A 与 K 之间的取舍【永远由分值项决定】，轮不到件加成 ——
  //     keepValue 的差经过 preserve 的 0.25 之后只有个位数，而「副K 带 10 分」
  //     那条 candidatePoints * 12 是 120 分，差两个数量级，怎么调都翻不过来。
  //     实测把件加成改成 A=80/K=40，300 局里「A 先走」只从 58% 动到 56%。
  //   · 真正会被改动的是【副A 和低主牌】的相对顺序（副A 59 vs 主花色最低 78），
  //     那是另一个问题（垫副A 还是垫小主），没有牌理依据前不要顺带改掉。
  // 真正管住件的是「亮件的基础代价」那条显式规则，不是这张牌值表。
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
// 判据是【张数对比】：从顶档往下累计，只要「别人手上能压我的张数」少于
// 「我自己这一档及以上的张数」，保底就成立 —— 对手的大牌一张只能换掉我一张，
// 换不完，我必然还剩一张能拿下最后一轮。同强度算别人能压我（先出者大，
// 我不能指望最后一轮由我先出），所以同档的张数要和我的一起累加再比。
//
// 关键是它【随出牌动态变化】：
//   开局什么都没出 → 只有双大鬼才算握住顶档；
//   别人打掉一张大鬼 → 我手里剩的那张大鬼就够保底了，不再需要小鬼、主2；
//   大鬼两张都出完了 → 我有双小鬼就够，以此类推；
//   我有大鬼 + 小鬼、外面只剩一张大鬼没现身 → 也够（Glen：「出了小鬼他就有了」）。
//
// ⚠️ 底牌那 8 张对电脑是未知的，一张顶主可能躺在底牌里永远不出现。
// 这里一律把「没见过」当成「可能在别人手上」——宁可低估自己的把握，
// 也绝不能在没保底时误以为有。
//
// 另一半条件是主牌【长度】：光握住最大的一张不够，主太短会先被吊空，
// 撑不到最后一轮。100 张牌四家分，平均每家 9 张主，低于这个数不算保底牌。
const BOTTOM_MIN_TRUMPS = 9;

// 亮一支件的代价。Glen 说这个「需要看当时的情况」，所以它不是一个固定门槛：
//   · 基准 240。「多大的分才值得冒这个险」不在这里算 —— 接管加分
//     （100 + totalPoints * 10）本来就表达了这件事，等效门槛落在 25 分上下，
//     正好对上他说的「20 分甚至 30 分那种大利益才值得冒险」
//   · 再按【对手在这门可能还剩多长】缩放（PIECE_THREAT_BASELINE 张算一份），
//     因为真正的风险是「他因为我这张 A 能甩很长、得很多分」
//   · 上下夹住，免得极端牌型把它放大成一票否决
const PIECE_EXPOSURE_COST = 240;

const PIECE_THREAT_BASELINE = 4;
const PIECE_THREAT_MIN = 0.5;
const PIECE_THREAT_MAX = 2;
// 读牌对风险的缩放（Glen 的三档，且他强调「不能是 100%」，所以都不是 0）：
//   对家求过这门 → 件多半在他那，亮出去多半是帮自己人凑齐
//   谁都没求过   → 对手这门多半不强、件不多且很短
//   对手求过     → 不缩放（保持原值），他正等着这门
const PIECE_READ_PARTNER_ASKED = 0.35;
const PIECE_READ_NOBODY_ASKED = 0.7;
// 打完这一手之后这门只剩几张就算「快断了」。Glen：「如果自己这门已经快断了，
// 比如打 A 后再捅多一支或两支就断了，可以毙别人，这个时候也可以吃。」
const PIECE_NEAR_VOID_AFTER = 2;

// 「砍下去就保不了底、而且分还没到移庄线」时，放走这一墩的分量。
// 要压得过接管加分（最后一家时是 100 + 分×10 + 45），否则拦不住。
const OVER_KILL_PENALTY = 1200;

// 本局策略对领牌的加权。数值挑在「够翻得动兜底选项、但压不过约定打法」这个区间：
// develop-long-side-suit 本身 160，加上之后 360 —— 高过 attack-opponent-long-suit(250)，
// 仍低于 seek-piece(450) 和各种约定（620+），不会把 Glen 定过的那些打法盖掉。
const STRATEGY_RUN_SIDE_BONUS = 200;

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

  // 从最高档往下【累计比较张数】，而不是要求独占顶档。
  //
  // Glen 实战：手上大鬼 + 小鬼，另一张大鬼一直没现身。按「独占顶档」判 ——
  // 顶档有牌在外 → 不保底，于是电脑一路吊主，吊到手里只剩那两个鬼。
  // 但队友把另一张小鬼打出来之后，场上能压我的只剩【一张】大鬼，而我有【两张】
  // 顶牌：对手那张大鬼只能换掉我一张，剩下那张必然拿得下最后一墩。
  // 这就是他说的「出了小鬼他就有了」—— 保底是数出来的，不是独占出来的。
  //
  // 判据：走到某一档时
  //   mineAtOrAbove = 我手上这一档及以上的张数
  //   threats       = 别人手上（含底牌）这一档及以上的张数
  // threats < mineAtOrAbove ⇒ 对手的大牌不够把我的顶牌一张张换掉 ⇒ 保底成立。
  // 同强度也算威胁（同强度先出者大，他领这一档我压不过），所以同一档的
  // outstanding 必须和 mine 在同一轮里一起累加，不能先判后加。
  //
  // 原来那条「独占顶档」是本式在第一档的特例（threats 0 < mine 1），已被包含。
  // 顺带记下 topOutstanding：走到【我手上最大的那一张】所在的档时，
  // 比它更大或与它同档、还没现身的牌一共几张 —— 也就是「还有几张能从我手里
  // 抢走一墩」。清顶判断（trumpClearingOut）用的就是它。我一张主都没有时为 ∞。
  let mineAtOrAbove = 0, threats = 0, holdsTopTrump = false, topOutstanding = null;
  for (const [, tier] of [...tiers.entries()].sort((a, b) => b[0] - a[0])) {
    mineAtOrAbove += tier.mine;
    threats += tier.total - tier.played - tier.mine; // 别人手上或底牌里
    if (tier.mine > 0 && topOutstanding === null) topOutstanding = threats;
    if (tier.mine > 0 && threats < mineAtOrAbove) { holdsTopTrump = true; break; }
  }

  return {
    holdsTopTrump,
    topOutstanding: topOutstanding ?? Number.POSITIVE_INFINITY,
    trumpCount: myTrumps.length,
    guaranteed: holdsTopTrump && myTrumps.length >= BOTTOM_MIN_TRUMPS,
  };
}

// assessBottomControl 每次都要 buildDeck()（108 张），而跟牌打分对每个候选
// 都会问一次。按 view 对象记忆化：同一次决策里只算一遍。
const BOTTOM_CONTROL_CACHE = new WeakMap();
function bottomControlOf(view, ctx) {
  const cached = BOTTOM_CONTROL_CACHE.get(view);
  if (cached) return cached;
  const value = assessBottomControl(view, ctx);
  BOTTOM_CONTROL_CACHE.set(view, value);
  return value;
}

// 打出 cards 之后的保底判定 —— 「这一下会不会把底丢掉」。
//
// ⚠️ 不能只把 cards 从手牌里删掉：assessBottomControl 把「既不在我手上、又没现过身」
// 的牌算成【别人可能攥着的威胁】，那样刚打出去的牌会凭空变成威胁。
// 照实构造「我出完这一手之后」的视角：手牌里去掉，currentTrick 里加上。
function bottomControlAfter(view, ctx, cards) {
  const spent = new Set(cards.map(card => card.id));
  return assessBottomControl(
    {
      ...view,
      you: { ...view.you, hand: (view.you?.hand ?? []).filter(card => !spent.has(card.id)) },
      round: {
        ...view.round,
        currentTrick: [...(view.round?.currentTrick ?? []), { seat: view.you.seat, cards }],
      },
    },
    ctx
  );
}

// 场上还有多少张主牌没露面（不含我手上的；底牌里的仍算未知，故偏高）
function outstandingTrumpCount(view, ctx) {
  const total = buildDeck().filter(card => suitOf(card, ctx) === 'TRUMP').length;
  const played = playedCardsOf(view).filter(card => suitOf(card, ctx) === 'TRUMP').length;
  const mine = cardsOfSuit(view.you?.hand ?? [], 'TRUMP', ctx).length;
  return Math.max(0, total - played - mine);
}

// 「求件」的领牌长什么样（Glen：「第一轮求件是需要打 5 以下，甚至 10 也可以」）。
// 单张、不是件本身、点数很小或是 10 —— 这就是在跟同伴要件。
// 反过来「如果不想对家把件很快放出来，千万第一轮不打 5 以下」：
// 领大牌不算求件，别人也不该按求件来应答。
function isPieceRequestLead(cards, ctx) {
  return (
    Array.isArray(cards) && cards.length === 1 &&
    cards.every(card => !isSidePiece(card, ctx)) &&
    cards.every(card => card.rank <= 5 || card.rank === 10)
  );
}

// 庄家首轮吊主【带分】—— 一条明确的约定（Glen）：
//   「庄家如果首轮吊主打个分出来，证明至少有一个大鬼，但没有绝对的保底牌，
//     希望对家表示他的大牌。对家如果有大鬼，可以用大鬼吃了之后转打副牌，
//     或者不用大鬼吃，转打副牌，都是『不用吊主』的表达。」
function declarerTrumpPointSignal(view, ctx) {
  const first = (view.round?.trickHistory ?? [])[0];
  if (!first || first.leadSeat !== view.declarerSeat || first.leadSuit !== 'TRUMP') return false;
  const cards = first.plays?.[0]?.cards ?? [];
  return cards.length > 0 && cards.some(card => cardPoints(card) > 0);
}

// 「带分吊主」这个约定是【双向】的，原来只写了应答的一半：队友收到信号会转副牌，
// 庄家自己却从不回头看队友答没答，于是一路吊下去。Glen 实战里正是这样 ——
// 他用小鬼应了，庄家还在吊，吊到手上只剩两个鬼。
//
// 应答有两种形态，Glen 说「都是『不用吊主』的表达」：
//   1. 在信号那一墩用鬼吃下来 —— 第一墩队友必须跟主，他能表达的只有出不出顶张
//   2. 之后拿到牌权时【领副牌】 —— 电脑队友走的就是这条（它不肯早早交出鬼）
// 收到应答就说明顶端有人管得住，庄家该转去跑副牌，不必再削对手的主。
function trumpSignalAnswered(view, ctx) {
  if (view.you?.seat !== view.declarerSeat) return false;
  if (!declarerTrumpPointSignal(view, ctx)) return false;
  const partner = partnerSeatOf(view.you.seat);
  const history = view.round?.trickHistory ?? [];
  const answer = (history[0]?.plays ?? []).find(play => play.seat === partner);
  if ((answer?.cards ?? []).some(card => card.rank === 15 || card.rank === 16)) return true;
  return history.slice(1).some(
    trick => trick.leadSeat === partner && trick.leadSuit !== 'TRUMP'
  );
}

// ---- 本局策略（Glen 口述的「策略支持」）----
//
// 「BOT 在玩的时候，也需要有一定的策略支持，然后一直跟随这个策略支持去打。」
//
// 【每墩重算，但维持原策略有很大惯性】（Glen 定的口径）——
// 既不能因为局面微变就摆动，也不硬锁到底。
// ⚠️ 惯性不靠新增状态实现：我【自己过去领了什么牌】本来就是公开记录，
// 从中读出「我一直在执行哪个策略」给它加权就够了（declarerLeadStyle 已是这个思路）。
// 电脑只吃 viewerState 的本人视角这条硬约束不能破。
//
// 庄家（默认保底优先）：
//   'run-side'      有保底牌 + 主长     → 以跑副牌为主
//   'run-and-score' 有保底牌 + 主不长   → 跑牌兼跑分
//   'tail-throw'    有够长的副牌能甩    → 算好主牌数量，甩尾手让对方毙不了
//   'draw-trumps'   没保底牌但主还长    → 尽量吊主（自己主长别人就短）
//   'points-first'  保底已经不现实      → 改为跑分为主
// 闲家（默认吃分为主）：
//   'grab-bottom'   主又长又大          → 撬底
//   'points-first'  其余                → 吃分为主，核心是「打别人不想自己打的牌」
//
// 「保底已经不现实」的判据是 Glen 给的三条【同时】成立：
//   副牌基本无威胁（件都给对方抓死、没机会甩）+ 顶牌数不够 + 主牌也不够长。
function bottomHopeless(view, ctx, control) {
  return (
    !hasStrongSideSuit(view, ctx) &&
    !control.holdsTopTrump &&
    control.trumpCount < BOTTOM_MIN_TRUMPS
  );
}

// 我自己过去领的牌 —— 惯性的来源。返回我领过的最近一次是主牌还是副牌。
function myLeadStyle(view) {
  const mine = (view.round?.trickHistory ?? []).filter(
    trick => trick.leadSeat === view.you?.seat
  );
  const last = mine[mine.length - 1];
  if (!last) return null;
  return last.leadSuit === 'TRUMP' ? 'trump' : 'side';
}

export function roundStrategy(view, ctx, control = bottomControlOf(view, ctx)) {
  const role = leadRole(view);
  const trumps = cardsOfSuit(view.you?.hand ?? [], 'TRUMP', ctx);
  const plan = tailThrowPlan(view, ctx, control);
  const style = myLeadStyle(view);

  if (role === 'defender') {
    // 闲家：主又长又大就撬底，否则吃分为主
    if (control.holdsTopTrump && trumps.length >= BOTTOM_MIN_TRUMPS) return 'grab-bottom';
    return 'points-first';
  }

  // 庄家一方
  if (bottomHopeless(view, ctx, control)) return 'points-first';
  if (plan) return 'tail-throw';
  if (control.holdsTopTrump) {
    return trumps.length >= BOTTOM_MIN_TRUMPS ? 'run-side' : 'run-and-score';
  }
  // 没有保底牌：主还长就吊主。惯性 —— 我一直在吊主的话，门槛放宽一张，
  // 免得主牌被吊掉一张就改弦更张（Glen 要的「一直跟随这个策略」）。
  const drawFloor = style === 'trump' ? BOTTOM_MIN_TRUMPS - 1 : BOTTOM_MIN_TRUMPS;
  if (trumps.length >= drawFloor) return 'draw-trumps';
  return 'run-and-score';
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

// ---- 甩尾手（Glen 的长期计划打法）----
//
// 「这个是比较长期的一个策略，一般和甩尾手也有相关，就是计划起手然后甩一手长的
//   副牌达到保底或是撬底的目的。这样的打法一般需要有起手牌，比如说有个大鬼，
//   打完大鬼就可以甩尾手，或是用主牌去毙。」
// 又：「对手要是主牌不够长，有多少个鬼都不能保底」——
//   甩 N 张副牌得有 N 张主牌才毙得住，这是对「靠鬼保底」的正面反制。
//
// 计划要三个条件同时成立：
//   1. 有一门够长、且【甩牌资格已成立】的副牌（暗求就是为了把这个条件凑齐）
//   2. 手上有【起手牌】：握着当前仍未打出的主牌里最高的那一档，
//      保证能在自己想要的时刻拿到牌权（holdsTopTrump 正是这个判定）
//   3. 现在甩还毙得住 → 那就【先别甩】，留到尾巴上
//
// ready 的判据：甩 N 张副牌，只有【单独一家】手里同时有 N 张主牌才毙得住整手，
// 所以要看的不是场上主牌总数，而是【某一家最多可能有多少张】。
// 未现牌按各家手牌数摊分 —— 底牌那 8 张也占一份，而底牌里的主牌永远不会
// 出现在牌面上，毙不了我，这一份摊出去正好把它扣掉了。
function maxOpponentTrumpEstimate(view, ctx) {
  const outstanding = outstandingTrumpCount(view, ctx);
  const others = (view.players ?? []).filter(player => player.seat !== view.you.seat);
  const hidden =
    others.reduce((sum, player) => sum + (player.handCount ?? 0), 0) +
    (view.round?.kittyCount ?? 0);
  if (hidden <= 0) return outstanding;
  let worst = 0;
  for (const player of others) {
    if (player.seat % 2 === view.you.team) continue; // 队友的主牌不会来毙我
    worst = Math.max(worst, (outstanding * (player.handCount ?? 0)) / hidden);
  }
  return worst;
}

// 某一门副牌，【单独一家对手】最多可能握着多少张 —— 和 maxOpponentTrumpEstimate
// 同一套算法（未现牌按各家手牌数摊分，底牌那份摊出去正好扣掉）。
// 用来衡量「我亮这支件之后，他能甩多长」。
function maxOpponentSuitEstimate(view, ctx, suit) {
  const total = buildDeck().filter(card => suitOf(card, ctx) === suit).length;
  const played = playedCardsOf(view).filter(card => suitOf(card, ctx) === suit).length;
  const mine = cardsOfSuit(view.you?.hand ?? [], suit, ctx).length;
  const outstanding = Math.max(0, total - played - mine);
  const others = (view.players ?? []).filter(player => player.seat !== view.you.seat);
  const hidden =
    others.reduce((sum, player) => sum + (player.handCount ?? 0), 0) +
    (view.round?.kittyCount ?? 0);
  if (hidden <= 0) return outstanding;
  let worst = 0;
  for (const player of others) {
    if (player.seat % 2 === view.you.team) continue; // 队友甩这门不是威胁
    worst = Math.max(worst, (outstanding * (player.handCount ?? 0)) / hidden);
  }
  return worst;
}

// 这门的件大概在谁手上 —— 靠【谁在这门求过牌】来读（Glen）：
//
// 「首先看对家有没有求牌，如果有，一般情况下就在对家；其次看对手两个人有没有求牌，
//   如果没求，那么多数情况下他们这门副牌肯定不强，件一般也不多，多的话也很短。
//   通常会看『打这门牌的欲望』来判断该门牌的件在什么位置，
//   但这也不能是 100%，因为有些人打法不一样，常理也会有例外。」
//
// ⚠️ 他自己点明了这不是 100%，所以只做【强先验】—— 缩放亮件的风险，
// 不做一票豁免。「打这门牌的欲望」落成可观测行为：谁在这门领过求件牌
//（5 以下的小牌或 10，判据复用 isPieceRequestLead）。
function suitAskSignal(view, ctx, suit) {
  const partner = partnerSeatOf(view.you.seat);
  // ⚠️ 必须把【当前这一墩】也算进来 —— 眼前正在发生的求件才是最相关的信号。
  // 只扫历史墩的话，对手这一墩刚领了张小牌来求这门，我却读成「谁都没求过」，
  // 反而把风险调低了，正好读反。
  const current = (view.round?.currentTrick ?? [])[0];
  const leads = [
    ...(view.round?.trickHistory ?? []).map(trick => ({
      seat: trick.leadSeat, suit: trick.leadSuit, cards: trick.plays?.[0]?.cards ?? [],
    })),
    ...(current ? [{ seat: current.seat, suit: current.playSuit, cards: current.cards ?? [] }] : []),
  ];
  let partnerAsked = false;
  let opponentAsked = false;
  for (const lead of leads) {
    if (lead.suit !== suit) continue;
    if (!isPieceRequestLead(lead.cards, ctx)) continue;
    if (lead.seat === partner) partnerAsked = true;
    else if (lead.seat % 2 !== view.you.team) opponentAsked = true;
  }
  // ⚠️ 顺序按 Glen 的原话：「【首先】看对家有没有求牌，如果有，一般情况下就在对家；
  // 【其次】看对手两个人有没有求牌」。两边都求过时以对家为准 ——
  // 第一版把对手判在前面，结果队友那条信号永远没机会生效。
  if (partnerAsked) return 'partner';   // 对家在要这门 —— 件多半在他那
  if (opponentAsked) return 'opponent'; // 只有对手在要 —— 风险照旧，别亮
  return null;                          // 谁都没求过
}

// 这一手里【亮出去几份件的风险】——领牌和跟牌共用同一份判据（Glen）。
//
// 「如果对家没表示，那么最好是不随便出，因为这个是冒险的行为。比如别人有三件，
//   你不知道，贸然出了后，给对方甩了 10 几支，对我方的威胁就非常大了。」
//
// 亮一支件 = 把这门的一支从「未现」永久变成「已现」。canThrowByStatus 只要求
// 每支件都 !== 'unseen'，所以每亮一支就是替【攥着其余件的人】往甩牌资格上推一格 ——
// 而三家里有两家是对手。
//
// 四种情况不算风险：
//   · 这门的件已经全现了 —— 亮不亮都一样
//   · 这门够格当求件方（strongPieceSuit）—— 我就是要凑齐条件的那个人
//   · 队友表示过这门 —— 「如果对家，那是可以很没压力地出件的」
//   · 我这门打完就快断了 —— 「打 A 后再捅多一支或两支就断了，可以毙别人，
//     这个时候也可以吃」。断门之后我能用主牌毙，反而是优势。
// 风险的大小看【对手在这门可能还剩多长】：他能甩得越长，亮件越亏。
function pieceExposureRisk(view, ctx, cards, partnerAskedSuit, tuning) {
  const hand = view.you?.hand ?? [];
  return cards.reduce((sum, card) => {
    if (!isSidePiece(card, ctx)) return sum;
    const suit = suitOf(card, ctx);
    const stillHidden = (view.round?.piecesView?.[suit] ?? [])
      .filter(item => item.status === 'unseen').length;
    if (stillHidden === 0) return sum;
    // 三件在手、只差一支 —— Glen 点名的那条求件打法（AAK 打 K、AKK 打 A）。
    // 亮出去的这一支正是【替我自己】把甩牌条件凑齐的那一步，不算冒险。
    // 和 pieceSeekingLead 里那条精确分支用的是同一个判据。
    const held = (view.round?.piecesView?.[suit] ?? [])
      .filter(item => item.status === 'mine').length;
    if (held >= 3 && stillHidden === 1) return sum;
    if (strongPieceSuit(view, ctx, suit, tuning)) return sum;
    if (partnerAskedSuit === suit) return sum;
    const spentHere = cards.filter(item => suitOf(item, ctx) === suit).length;
    if (cardsOfSuit(hand, suit, ctx).length - spentHere <= PIECE_NEAR_VOID_AFTER) return sum;
    const threat = maxOpponentSuitEstimate(view, ctx, suit) / PIECE_THREAT_BASELINE;
    const signal = suitAskSignal(view, ctx, suit);
    const read = signal === 'partner' ? PIECE_READ_PARTNER_ASKED
      : signal === null ? PIECE_READ_NOBODY_ASKED
      : 1;
    return sum + Math.min(PIECE_THREAT_MAX, Math.max(PIECE_THREAT_MIN, threat)) * read;
  }, 0);
}

function tailThrowPlan(view, ctx, control) {
  if (!control.holdsTopTrump) return null; // 没有起手牌，这个计划无从谈起
  const hand = view.you?.hand ?? [];
  let best = null;
  for (const suit of SUITS.filter(item => item !== ctx.trumpSuit)) {
    const cards = cardsOfSuit(hand, suit, ctx);
    if (cards.length < 3) continue; // 太短甩了没意义
    if (!canThrowByStatus(view.round?.piecesView?.[suit])) continue;
    if (!best || cards.length > best.cards.length) best = { suit, cards };
  }
  if (!best) return null;
  const worstOpponentTrumps = maxOpponentTrumpEstimate(view, ctx);
  return { ...best, worstOpponentTrumps, ready: worstOpponentTrumps < best.cards.length };
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

// ---- 清顶：对手主牌见底时，反过来该用大牌把顶端一次清完 ----
//
// Glen 纠正了上一版的绝对化（「永远不含鬼」写死了）：
//   「这个结论也太绝对，潮汕升级的玩法就是随时都需要看当时形势来定要出的牌，
//     如果当时判断对手的主已经很少、很可能把大牌撞出来的时候，
//     那这情况就可以吊大鬼小鬼主2。」
// 常态仍然是「鬼和主级牌留着杀」，但那是【强先验】，不是硬规则 ——
// 形势到了就该翻过来。
//
// Glen 给的两条是「对手的主已经很少」+「很可能把大牌撞出来」。
//
// ⚠️ 第二条我第一版译成了「顶端只剩一两张没现身」——【错的】。
// 领大鬼【逼不出】对手的大鬼：他手里只要还剩一张小主，跟一张小的就躲过去了，
// 我白花一张顶牌。真正撞得出来的条件是【外面剩的主牌基本全是大牌】——
// 他没有小主可垫，只能拿大牌来跟。
// 400 局逐局配对实测（scripts/audit/clearing-paired.mjs）：
//   错的那版 保底 283 → 269，结果翻转 2 好 / 16 坏；换成这条 284，1 好 / 0 坏。
// 放宽到「还允许剩 2 张小主」立刻退回 283（1 好 1 坏），剩 3 张退到 281。
//
// 第一条【不再单独判】：本判据成立时它恒为真，写上去就是会骗过变异测试的死代码。
// 四家手牌数始终相等（每墩各出同样张数），所以
//   maxOpponentTrumpEstimate = 外面主牌数 × h / (3h + 8) < 外面主牌数 / 3 ≤ 1 ≤ 2。
// 400 局逐局对比也确认：去掉它之后每一局的结果都一模一样。
const CLEARING_MAX_TOP_OUTSTANDING = 2;   // 顶端还剩几张没现身
const CLEARING_MAX_LOW_OUTSTANDING = 1;   // 外面还允许剩几张【压不到我】的小主

//
// 注：这里【不】另外判「主牌是不是已经吊光」——两个调用点本来就拦住了那个局面
// （开局时主牌不可能已出尽；开局之后那条提案自带 outstandingTrumps > 0）。
// 多写一条是恒真守卫，删掉行为不变，却会让变异测试误以为它被覆盖了。
function trumpClearingOut(view, ctx, control) {
  const top = control.topOutstanding;
  if (top < 1) return false;                          // 顶端已经空了，没有大牌可撞
  if (top > CLEARING_MAX_TOP_OUTSTANDING) return false; // 顶上还有一大把，撞不干净
  return outstandingTrumpCount(view, ctx) - top <= CLEARING_MAX_LOW_OUTSTANDING;
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
// 吊主该出哪张。
//
// ⚠️ 默认一律吊【小牌】。吊大牌是为了抢主动权，只在【明确需要】时才做 ——
// Glen 两次实战反馈都栽在这上面（先是拿鬼去吊，改完又拿级牌去吊；
// 打 7 时级牌恰好就是主7/副7，看着就是「第一墩吊了个 7」）。
//
// 为什么开局尤其不能吊大牌（Glen 原话的意思）：
//   第一墩还不知道队友要不要吊主，而「要不要吊主」直接决定后面怎么打 ——
//   队友一旦表示不用吊，庄家就可以放心走强势副牌、甩牌也不怕底被撬。
//   所以第一墩要先放小牌，把表态的机会让出去。
//
// 什么才叫「明确需要」：我有一门副牌要甩，而对手可能毙得动它 ——
// 必须先把他的主削到毙不动。这正好就是 tailThrowPlan 挂起的那个状态，
// 所以 aggressive 由调用方按「计划挂起」来传，这里不自己猜。
//
// 三档，由调用方按形势选（trumps 里含不含鬼也由调用方决定，见 drawPool）：
//   'low'      默认。弱势吊小牌，逼对手用大牌来杀 —— 拿我的小牌换他的大牌。
//   'tier'     甩尾手计划挂起、明确需要削对手的主：吊【副级牌】那一档。
//              Glen：「通常都是打副7，主7以上一般拿来杀的」。打 7 时阶梯是
//              大鬼 > 小鬼 > 主7 > 副7 > 主花色 A…，副级牌是级牌里最便宜的一档：
//              够大、逼得出对手的主，又不是毙牌的本钱。
//   'clearing' 对手主牌见底、顶端只剩一两张：反过来领最大的，把顶端一次清完。
//              连吊「先大后小」是自然结果 —— 大鬼打出去之后重新评估，
//              次大的那张就成了新的最大张。
function drawingTrumpCard(trumps, ctx, { mode = 'low' } = {}) {
  if (mode === 'low') return lowestLead(trumps, ctx);
  if (mode === 'clearing') return highCards(trumps, 1, ctx)[0];
  const drawable = trumps.filter(
    card => !(card.rank === ctx.rankCard && card.suit === ctx.trumpSuit)
  );
  return highCards(drawable.length ? drawable : trumps, 1, ctx)[0];
}

// 「求件方资格」—— 这门够不够强，值不值得去求件（Glen 口述的门槛）：
//   「求件方一般会这门副牌比较强，如有两件以上不少于 6 支，
//     或是有一件但很长，8 支 9 支以上。」
//
// ⚠️ 这一条管的是【我该不该主动求件】，不是【该不该应答队友的求件】——
// 应答看的是队友有没有表示 + 桌上有没有大分，两码事。
//
// tuning.pieceProbeMinLength 仍然管两件那一档的长度门槛（进化权重是 6，正好对上）；
// 单件那一档另外要求更长，原来一律用同一个门槛，单件时松了两三张。
const SINGLE_PIECE_MIN_LENGTH = 8;

function strongPieceSuit(view, ctx, suit, tuning = strategyTuning(view)) {
  const cards = cardsOfSuit(view.you?.hand ?? [], suit, ctx);
  const mine = (view.round?.piecesView?.[suit] ?? [])
    .filter(item => item.status === 'mine').length;
  if (mine >= 2) return cards.length >= tuning.pieceProbeMinLength;
  if (mine >= 1) return cards.length >= SINGLE_PIECE_MIN_LENGTH;
  return false;
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
    // ⚠️ 门槛按 Glen 的口径分两档（strongPieceSuit）：两件以上 ≥6 支，或单件 ≥8 支。
    // 原来两档共用 pieceProbeMinLength，单件时松了两三张 —— 一件配六张就去求件，
    // 那门其实并不强，逼出来的件多半是喂给对手。
    if (unseen >= 1 && strongPieceSuit(view, ctx, suit, tuning)) {
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
  const control = bottomControlOf(view, ctx);
  const plan = tailThrowPlan(view, ctx, control);
  const strongSide = hasStrongSideSuit(view, ctx);
  const outstandingTrumps = outstandingTrumpCount(view, ctx);
  const role = leadRole(view);

  // 庄家首出：不够保底就先吊主，表示「我自己保不了底」；够保底则从副牌开始发展。
  // 判据从「有没有双大鬼」换成完整的保底判定（补上了主牌长度这一半 ——
  // 双大鬼但只有 5 张主，照样会被吊空，不算保底牌）。
  const hasBigJoker = hand.some(card => card.rank === 16);
  // 吊主的候选【常态下不含鬼】。Glen：「主7以上一般拿来杀的」——
  // 领鬼不是吊主，是把毙牌的本钱扔掉。手上只剩鬼当主牌时干脆不提吊主，
  // 让副牌路线接手（真到了全手只剩主牌，low-card-fallback 仍会兜住）。
  //
  // 例外是【清顶】：对手主牌见底、顶端只剩一两张时，鬼重新进候选，而且要领最大的
  // 把顶端一次清完（Glen：「这个结论也太绝对……那这情况就可以吊大鬼小鬼主2」）。
  const drawableTrumps = trumps.filter(card => card.rank !== 15 && card.rank !== 16);
  const clearing = trumpClearingOut(view, ctx, control);
  const drawPool = clearing ? trumps : drawableTrumps;
  if (opening && isDeclarer && !control.guaranteed && drawPool.length > 0) {
    // 有大鬼但不够保底 → 首轮吊主【带分】，向队友表态「我有大鬼，但保不了底，
    // 请你表示你的大牌」。挑最小的那张带分主牌，别为了发信号丢掉大牌。
    const pointTrump = hasBigJoker
      ? [...trumps.filter(card => cardPoints(card) > 0)]
          .sort((a, b) => cardStrength(a, ctx) - cardStrength(b, ctx))[0]
      : null;
    addProposal(
      // 开局绝不 aggressive：先放小牌，把「要不要吊主」的表态机会让给队友
      [pointTrump ?? drawingTrumpCard(drawPool, ctx)],
      900 * tuning.conventionPriorWeight,
      'dealer-opening-trump-signal'
    );
  }

  // 开局之后的持续吊主
  // ⚠️ 计划挂起时【不能】因为「副牌够强」就停止吊主 —— 恰恰相反：
  // 吊主正是在削减对手手上的主牌，等他们凑不出足够的主，尾巴那一甩才毙不住。
  // Glen：「求到件了可以转吊主」。
  const planPending = plan !== null && !plan.ready;

  // ---- 本局策略接到领牌上（Glen：「一直跟随这个策略支持去打」）----
  //
  // ⚠️ 吊主那一段【故意不动】：那里压着 Glen 七轮实战反馈调出来的判据
  //（信号应答、保底成立、副牌够强、清顶、开局先放小牌……），策略层越过它们
  // 重写一遍只会把那些判据推翻。这里只接目前【完全没有表达】的那一半：
  //   run-side / run-and-score → 「以跑副牌为主」（Glen 对这两种策略的原话）
  //   points-first             → 「核心是打别人不想自己打的牌，多找机会吃分」
  const strategy = roundStrategy(view, ctx, control);
  if (!opening && drawPool.length > 0 && outstandingTrumps > 0 &&
      !control.guaranteed && (!strongSide || planPending)) {
    const drawBonus =
      planPending ? 560                                                // 为尾巴削对手的主
      // 队友已经应了「不用吊主」→ 转去跑副牌保底，别再削对手的主。
      // 策略已经是「跑分为主」（保底不现实）→ 同样别再吊：Glen 明说这时候
      // 「就可以改为跑分为主」，一个已经放弃保底的庄家再拿仅剩的主牌去吊，
      // 既削不动对手，也换不回分 —— 这就是「一直跟随这个策略去打」的意思。
      : role === 'declarer'
        ? (trumpSignalAnswered(view, ctx) || strategy === 'points-first' ? 0 : 520)
      : role === 'declarerPartner'
        // 收到庄家「带分吊主」的信号而自己确实有大鬼 → 转打副牌，
        // 这本身就是「不用吊主」的表达（Glen）。否则照常跟庄家路子。
        ? (declarerLeadStyle(view) === 'trump' &&
           !(hasBigJoker && declarerTrumpPointSignal(view, ctx)) ? 480 : 0)
      : 0;                                                             // 闲家：随便
    if (drawBonus > 0) {
      addProposal(
        // 只有甩尾手计划挂起时才算「明确需要」—— 那时确实要把对手的主削到毙不动
        // 清顶优先于甩尾手的「吊副级牌」：顶端马上就能清完，先清完再说
        [drawingTrumpCard(drawPool, ctx, {
          mode: clearing ? 'clearing' : planPending ? 'tier' : 'low',
        })],
        drawBonus * tuning.leadStrategyPriorWeight,
        'continue-trump-draw'
      );
    }
  }

  // 已确认有全主对手能全毙最后一手副牌时，甩牌扣底路线在张数守恒下已经断掉。
  // 若自己还有大鬼，先兑现这墩确定牌权，让朋友安全上分，而不是先甩后两墩全输。
  //
  // ⚠️ trumps.length === 1 这一条是 Glen 实战反馈后补上的：
  //   「上家无缘无故吊主吊了只大鬼出来……当时也不是场上的主已经出了很多、想把别人的
  //     大鬼碰出来的情况，也不是吊了大鬼就有一手长的副牌可以甩的情况。
  //     刚好这局我有一只大鬼和两个小鬼，那么上家一把大鬼打出来，我就没有任何的威胁了。」
  // 这条提案原来只看「对手全主」，不看自己手上还有没有别的主牌，于是中盘就把大鬼扔了出去，
  // 等于把顶端让给对手 —— 他剩下的鬼立刻变成场上最大的。
  //
  // 分界在【大鬼是不是我唯一的主牌】：
  //   · 是 → 留着也买不到第二次用处（既续不了吊、也毙不了第二墩），
  //     趁它还稳赢兑现一墩、让队友安全上分，是对的（这条路径原本就是为这个局面写的）
  //   · 否 → 手上还有别的主牌，办法多得是，大鬼必须留着
  // 实测 400 局：中前段领鬼 40 → 3 次。
  const bigJoker = hand.find(card => card.rank === 16);
  const sideSuitSet = new Set(nonTrumps.map(card => suitOf(card, ctx)));
  if (
    bigJoker &&
    nonTrumps.length > 0 &&
    trumps.length === 1 &&
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

  // 甩牌时机 —— 这是「甩尾手」的核心：能甩不等于现在就该甩。
  // 计划成立而时机未到（对手还有足够的主来毙）→ 压住不甩，先吊主削他们的主牌。
  // 时机一到 → 加分抬高，压过其它一切领牌意图，整门甩出去。
  const throwCards = safeSideThrow(view, ctx, tuning);
  if (throwCards) {
    const isPlanSuit = plan !== null && suitOf(throwCards[0], ctx) === plan.suit;
    if (!(isPlanSuit && !plan.ready)) {
      addProposal(
        throwCards,
        (isPlanSuit && plan.ready ? 1_100 : 620) * tuning.leadStrategyPriorWeight,
        isPlanSuit ? 'tail-throw' : 'safe-side-throw'
      );
    }
  }

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
      // ⚠️ 这里【故意没有】给「吃分为主」再加一份。试过 +200，变异测试显示它
      // 改变不了任何决策：points-first 时 develop 的加分本来就不适用
      //（那是 run-side 专属），attack(250) 已经稳压 develop(160)。
      // 「打别人不想自己打的牌」这个意思，靠的是【压掉吊主之后 attack 自然胜出】，
      // 不需要第二份加分。它唯一能改变的是和求件(450) 打平，没有依据这么做。
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
      // 「以跑副牌为主」的两种策略下，发展长副牌不再只是兜底选项
      (160 + (strategy === 'run-side' || strategy === 'run-and-score'
        ? STRATEGY_RUN_SIDE_BONUS : 0)) * tuning.leadStrategyPriorWeight,
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
      // 注：这里【故意没有】亮件的代价（pieceExposureRisk），试过又撤了：
      //   · 构造不出能钉住它的测试 —— 「光秃秃领一张件」本来就排不到
      //     develop-long-side-suit 前面（那条挑的是长门最小的无分牌）
      //   · 实测也毫无影响：领牌里「有替代选项却还是打件」的决策 249 → 252
      // 查下来早盘那些领牌亮件【全部来自被豁免的约定打法】（求件 / 续打贡献件 /
      // 回队友那门），不是失误。亮件的代价只写在跟牌那边（scoreFollow），那里才有
      // 真正的取舍。别再往这里加一遍。
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

  // 「刚好够赢 + 其余垫最便宜的」，多张跟牌版的「刚好能赢」。
  //
  // ⚠️ 判牌只比【最大的那一张】（server/trick.js 的 trickLeader → maxStrength），
  // 所以拿下一墩只需要一张够大的，其余张数用最便宜的凑就行。
  // 而上面的 selections 只生成三种形状：全小 / 全大 / 全分 ——
  // 一旦「全小」赢不下来，「全大」就成了唯一能赢的选项。
  // Glen 实战里毙对手两张甩牌时把【两只大鬼】一起交了出去，正是这么来的
  //（一只鬼配一张最小的主完全够，剩下那只鬼还留着保底）。
  //
  // 按牌力从小往大试，第一组赢得下的就是最省的那组，只加这一个候选。
  const economical = pool => {
    if (pool.length < count) return [];
    const byStrength = [...pool].sort(
      (a, b) => cardStrength(a, ctx) - cardStrength(b, ctx) || a.id.localeCompare(b.id)
    );
    for (const winner of byStrength) {
      const rest = pool.filter(card => card.id !== winner.id);
      const set = [winner, ...lowCards(rest, count - 1, ctx)];
      if (set.length !== count) continue;
      const led = trickLeader(
        [...view.round.currentTrick, { seat: view.you.seat, cards: set }],
        ctx
      );
      if (led?.seat === view.you.seat) return [set];
    }
    return [];
  };

  if (count === 1) {
    // 单张跟牌把所有合法牌都交给评分器，才能选出“刚好能赢”的那张。
    for (const card of hand) sets.push([card]);
  } else if (leadSuitCards.length >= count) {
    sets.push(...selections(leadSuitCards, count));
    sets.push(...economical(leadSuitCards));
  } else if (leadSuitCards.length > 0) {
    const rest = hand.filter(card => !leadSuitCards.includes(card));
    for (const fill of selections(rest, count - leadSuitCards.length)) {
      sets.push([...leadSuitCards, ...fill]);
    }
  } else {
    sets.push(...selections(hand, count));
    const trumps = cardsOfSuit(hand, 'TRUMP', ctx);
    sets.push(...selections(trumps, count));
    sets.push(...economical(trumps)); // 毙牌：一张够大的 + 最便宜的凑张数
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

  // 早中盘拿【鬼】去跟牌本身就该有代价 —— 鬼是保底/撬底的本钱，
  // 不是用来抢开局那几分的。值不值得只看这一墩的分够不够多。
  //
  // ⚠️ 原来两条保护都盖不住最常见的那个局面（Glen 两次实战反馈）：
  //   · spentLastBigJoker 只认【最后一张大鬼】，小鬼一点保护都没有；
  //   · isKill 的空毙惩罚要求 lead.playSuit !== 'TRUMP'，而【首家领主牌时
  //     isKill 恒为 false】—— 庄家开局吊主、后面几家拿鬼去压，代价为零。
  // 实测 40 局里，前两墩打鬼 11 次，全部是跟主牌墩。
  const jokersSpent = cards.filter(card => card.rank === 15 || card.rank === 16);
  if (early && jokersSpent.length > 0) {
    const cost = jokersSpent.reduce((sum, card) => sum + keepValue(card, ctx), 0);
    // 2.2 这个系数是扫出来的，不是拍的：只用 cost 本身时抢牌权的加分仍然压得过它，
    // 桌上 5 分就肯把小鬼扔出去；1.6 还剩 2 次；2.2 归零；3.0 没有更好 —— 拐点在 2.2。
    // 效果大致是「20 分以上才划算」，跟真人的直觉一致：开局那 5 分不值一张鬼。
    // 也确认过没有矫枉过正：领鬼次数 13 → 12，仍然都发生在第 3 轮之后。
    score -= Math.max(0, cost * 2.2 - totalPoints * 8) * settings.controlReserve * controlCaution;
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
  const donatedPieces = cards.filter(
    card => suitOf(card, ctx) === lead.playSuit && isSidePiece(card, ctx)
  ).length;
  const unseenPieces = (round.piecesView?.[lead.playSuit] ?? [])
    .filter(item => item.status === 'unseen').length;

  // ⚠️ 这里原来还有一条「对手求件时另罚 320、有分则打 0.45 折」的规则。
  // 已经并进下面那条统一的「亮件代价」——两条叠加会把等效门槛推到 37 分，
  // 比 Glen 说的「20 分甚至 30 分」高出一截；而且旧的那条只认「有没有分」，
  // 认不出他真正在意的两件事（对手这门可能多长、我自己是不是快断门了）。
  // 对手正在求件这个事实没有丢：它在下面被当作【威胁确认】，把代价调高一档。

  // ---- 队友求件时【贡献件】（积极的一半，以前完全没有）----
  //
  // 原来这里只写了消极的一半：别帮对手消件（上面的 -320）。
  // 队友求件时电脑没有任何动力把件贡献出去，于是 chooseLeadCards 里那条
  // 'continue-contributed-piece'（贡献一件拿到牌权后续打第二件）几乎触发不了。
  //
  // Glen 的判断链：
  //   「要确认对家是在求牌才这么打」—— 正常人没有件不会求牌，
  //     所以领出 5 以下的小牌（或 10）本身就是「我有件」的表态；
  //   「如果判断对家有甩牌条件，则要给他」—— 贡献之后这门就齐了，那就给；
  //   「如果在牌局中后段，看不出来他是很强势的牌，则不应该这么打」。
  const partnerProbe =
    lead.seat === partnerSeatOf(you.seat) && isPieceRequestLead(lead.cards, ctx);
  if (partnerProbe && donatedPieces > 0) {
    // unseenPieces = 我看不见的件（在队友或对手手上）。我打出【自己】的件，
    // 对队友而言就是把一张「未现」变成「已现」，他离甩牌条件更近一步。
    // ⚠️ 不能写成 unseenPieces - donatedPieces：打出自己的件并不会让别人
    // 手上那些未现件现身，两者不是一回事（第一版就写错了）。
    let bonus = 150 * donatedPieces;
    // 场面上只剩一件没露 → 队友既然开口求件，多半就攥着它，贡献这下大概率直接凑齐
    if (unseenPieces <= 1) bonus += 320;                  // 「有甩牌条件，则要给他」
    if (lead.seat === view.declarerSeat) bonus += 120;    // 队友做庄更需要这门做熟
    if (totalPoints > 0) bonus += totalPoints * 6;        // 顺带把分收回来
    if (!early) bonus -= 200;                             // 中后段看不出强势就别这么打
    // 乘 settings.inference：求件应答是「读牌 + 约定」类能力，
    // easy 电脑（inference = 0）本就不该会这一手，它只会老老实实跟小牌。
    score += bonus * settings.inference * tuning.conventionPriorWeight;
  }

  // ---- 亮件是冒险，默认不做（Glen）----
  //
  // 「如果对家没表示，那么最好是不随便出，因为这个是冒险的行为。
  //   比如别人有三件，你不知道，贸然出了后，给对方甩了 10 几支，
  //   对我方的威胁就非常大了。」
  //
  // 亮一支件 = 把这门的一支从「未现」永久变成「已现」。canThrowByStatus 只要求
  // 每支件都 !== 'unseen'，所以每亮一支就是替【攥着其余件的人】往甩牌资格上推一格 ——
  // 而三家里有两家是对手。上面那条 -320 只在【对手主动求件】时才算，
  // 对手正常领这门、或者我自己顺手打出去，一分保护都没有。
  // 实测：手牌 >12 张的早盘就有 965 次亮件，全是零分墩。
  //
  // 四种情况不罚：
  //   · 这门的件已经全现了 —— 亮不亮都一样
  //   · 这门够格当求件方（strongPieceSuit）—— 我就是要凑齐条件的那个人
  //   · 队友表示过这门 —— Glen：「如果对家，那是可以很没压力地出件的」
  //   · 【我这门打完就快断了】—— Glen：「打 A 后再捅多一支或两支就断了，
  //     可以毙别人，这个时候也可以吃」。断门之后我能用主牌毙，反而是优势。
  // 罚多少看【对手在这门可能还剩多长】，再拿这一墩的分去抵。
  // 注：不为「对手正在求这门」再单独加档 —— 他能甩多长 maxOpponentSuitEstimate
  // 已经算过了，再乘一次是重复计数，会把等效门槛从 25 分推到 37 分，
  // 高出 Glen 说的「20 分甚至 30 分」一截。
  const partnerAsked = partnerProbe ? { suit: lead.playSuit } : partnerRequest(view, ctx);
  const exposureRisk = pieceExposureRisk(view, ctx, cards, partnerAsked?.suit ?? null, tuning);
  if (exposureRisk > 0) {
    // ⚠️ 这里【不】再单独减一遍「这一墩的分」。Glen 的例外（「20 分甚至 30 分那种
    // 大利益也可以冒险」）已经由下面的接管加分表达了 —— 那一条本来就是
    // 100 + totalPoints * 10。再减一次是同一个激励算两遍，而且怎么都构造不出
    // 能钉住它的测试（变异成 payoff = 0，所有测试照样绿）。
    // 只留固定代价，等效门槛自然落在 246 ÷ 10 ≈ 25 分，正好是他说的那个数。
    // 本局策略是吃分为主时，同样的局面更该把分吃回来（Glen）
    const scale = roundStrategy(view, ctx, bottomControlOf(view, ctx)) === 'points-first'
      ? tuning.pointsFirstPieceWeight
      : 1;
    score -= exposureRisk * PIECE_EXPOSURE_COST * scale *
      pieceCaution * tuning.pieceProtectionWeight;
  }

  if (beforeTeamWinning) {
    if (afterTeamWinning) score += 45;
    else score -= 180;
    if (beforePartnerWinning) {
      // 朋友已经领先：送分、不抢牌权、绝不浪费主牌杀朋友。
      // 只有自己是最后一家时才能确定把分送到朋友手上。
      score += candidatePoints * (lastToAct || guaranteedPartnerControl ? 12 : 1);
      if (isKill) score -= 260;
      if (after?.seat === you.seat) {
        // 盖过【已经领先的队友】：这一墩本来就是我们的，压上去纯属浪费。
        //
        // ⚠️ 原来这里只罚 15 分，而 isKill 那条 -260 只在「副牌墩用主牌毙」时成立
        //（isKill 要求 lead.playSuit !== 'TRUMP'）。首家领的是主牌时 isKill 恒为
        // false，于是「队友领小鬼、我盖大鬼」总共只要 15 分代价，而大鬼的
        // keepValue 是 180 —— 等于没有代价。Glen 实战里正是这么出的问题。
        //
        // 罚额跟着【浪费掉的那张牌有多值钱】走：盖一张小牌无所谓，盖一张鬼是灾难。
        //
        // 但要分清「浪费」和「保分」：桌上有分、后面还有对手没出时，
        // 抢在队友前面拿下反而是在护住这些分，那时只能轻罚 ——
        // 第一版一律重罚，把这种正确的抢分也一并罚掉了。
        // 一分没有还盖上去，才是纯粹的浪费。
        const wasted = cards.reduce((best, card) => Math.max(best, keepValue(card, ctx)), 0);
        const protectingPoints = totalPoints > 0 && !lastToAct;
        score -= (15 + wasted * (protectingPoints ? 0.15 : 1.2)) *
          settings.controlReserve * controlCaution;
      }
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

  // ---- 护住甩尾手的计划 ----
  // 计划挂起时，长门的每一张都是尾巴的一部分：垫掉一张就少甩一张；
  // 起手牌（当前最高的未出主牌）更是整个计划的钥匙，早早花掉就再也拿不到
  // 自己想要的那个时刻的牌权，尾巴也就甩不成了。
  // 两条都是【强先验】：真有大分要收时，接管加分照样能压过去。
  const tailPlan = tailThrowPlan(view, ctx, bottomControlOf(view, ctx));
  if (tailPlan && !tailPlan.ready) {
    const planIds = new Set(tailPlan.cards.map(card => card.id));
    const spentTail = cards.filter(card => planIds.has(card.id)).length;
    // 首家领的就是这门时，跟牌是规则要求，不算自毁计划
    if (spentTail > 0 && lead.playSuit !== tailPlan.suit) {
      score -= spentTail * 90 * tuning.preserveWeight;
    }
    const topTrump = [...cardsOfSuit(you.hand, 'TRUMP', ctx)]
      .sort((a, b) => cardStrength(b, ctx) - cardStrength(a, ctx))[0];
    if (topTrump && cards.some(card => card.id === topTrump.id)) {
      score -= 240 * settings.controlReserve * controlCaution;
    }
  }

  // ---- 毙牌之前先算总账：这一毙值不值一张「底牌」（Glen 给的判据）----
  //
  // 庄家一方：「两个大鬼，别人那边还有小鬼，肯定两个都砍下去就保不了底了；
  //   送的分要看是送多少……如果送出去的分还有已经吃的分加起来还不到 80，
  //   那就判断如果不吃大，把小牌跑掉，大牌后边可以把分都跑了然后保底，
  //   肯定收益要比这轮把别人砍了更加多。」
  // 闲家一方：「闲家一个道理，这一墩杀下去，有可能本来的撬底牌就没有了……
  //   如果杀下去超过 80 分爆底，那么也无所谓撬不撬底了；
  //   如果杀下去分可能不够，那肯定不如留到最后撬底。」
  //
  // ⚠️ 两边是【同一本账】，不是两本 —— 第一版我按「只对庄家成立」写，是算窄了。
  // 被罚的动作同一个（拿顶主去毙），衡量的数也同一个：
  //   afterDefenderPoints = 闲家已吃的台面分 + 这一墩的分
  //     · 庄家方：让掉 → 这墩的分进闲家账，不到 80 就让得起，大牌留着保底
  //     · 闲家方：杀下去 → 这墩的分进自己账，到不了 80 就不值得花掉撬底牌
  // 差别只在理由叫「保底」还是「撬底」，算式一模一样。
  //
  // 两个条件【同时】成立才放走这一墩：
  //   1. 这一毙之后就握不住顶端了 —— 双大鬼一起交出去，外面那张小鬼就成了场上最大的
  //   2. 这一墩的分【到不了移庄线】—— 到得了就无所谓底了，该砍就砍
  //
  // ⚠️ 必须排在 economical 候选之后才有意义：能用「一鬼 + 一张小主」毙下来时
  // 顶端根本没丢，条件 1 就不成立 —— 先挑最省的打法，省不下来了才谈放不放。
  const afterDefenderPoints = (round.defenderTrickPoints ?? 0) + totalPoints;
  if (
    isKill &&
    afterDefenderPoints < DEFENDER_TARGET_POINTS &&
    bottomControlOf(view, ctx).holdsTopTrump &&
    !bottomControlAfter(view, ctx, cards).holdsTopTrump
  ) {
    score -= OVER_KILL_PENALTY * bottomWeight * tuning.bottomControlWeight;
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
