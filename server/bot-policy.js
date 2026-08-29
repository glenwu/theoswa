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

// 「这门有没有甩牌欲望」—— 求件信号该不该发，就看这一个量（Glen 第 1 条）。
//
// 他给的两条是【件多】或者【很长】：
//   · 件多 → strongPieceSuit，两件以上配 6 支、单件配 8 支，都是他的原话
//   · 很长 → 一件都没有就只能靠长度撑。可是「多长算长」他没给数，也不该写死；
//     他自己指了路：「其实你可以从已经打出去的牌去推断，这个是 bot 的优势，
//     可以很快的计划某一门可能剩多少张，而做出相对应的策略。」
//     所以判据是【比谁都长】：我这门比任何单独一家对手可能持有的都多
//    （maxOpponentSuitEstimate 就是按已打出的牌 + 各家手牌数摊出来的），
//     那甩出去就压得住、就有威胁。这个量随着牌打出去自己会收紧，不用调参。
function suitThrowAmbition(view, ctx, suit, tuning = strategyTuning(view)) {
  if (strongPieceSuit(view, ctx, suit, tuning)) return true;
  const mine = cardsOfSuit(view.you?.hand ?? [], suit, ctx).length;
  return mine >= 2 && mine > maxOpponentSuitEstimate(view, ctx, suit);
}

// 领牌时挑那一张，但【不要顺手发出求件信号】。
//
// 电脑并不是故意乱求的：develop-long-side-suit / attack-opponent-long-suit /
// 兜底这几条压根没有求件的意思，可它们一律挑「最小的无分牌」，一出手就是求件
// 信号（isPieceRequestLead：单张、非件、≤5 或 10）。真人读的是【信号】不是动机，
// 队友信了就把件交出来 —— 而这门的件多半在对手那边，等于白白替对手把甩牌资格
// 凑齐（canThrowByStatus 只要求每支件都别再「未现」）。
//
// 所以：本来要打的那张牌会不会被读成求件？会、而且这门没有甩牌欲望 → 换一张。
// 换成 6~9：天生无分，又在求件区（≤5 和 10）之上，正好是「就是想领这门」。
// 不取 J/Q —— 那两档是能赢墩的牌，为了避个信号提前扔掉，代价比信号本身还大；
// 手上一张 6~9 都没有就维持原判：宁可发个错信号，也不为了避信号去打件、送 10 分。
//
// ⚠️ 只在【本来那张真的会喊】时才换。不加这一步的话，最小那张明明是 ♠7、
// 也会被 6~9 这个筛子重挑一遍，白白改掉一堆和求件无关的领牌。
const QUIET_LEAD_MIN = 6;
const QUIET_LEAD_MAX = 9;

function quietLead(view, ctx, cards, tuning = strategyTuning(view)) {
  const shouts = card => {
    const suit = suitOf(card, ctx);
    return (
      suit !== 'TRUMP' &&                                  // 领主牌不是求件信号
      isPieceRequestLead([card], ctx) &&
      !suitThrowAmbition(view, ctx, suit, tuning)
    );
  };
  const natural = lowestLead(cards, ctx);
  if (!natural || !shouts(natural)) return natural;
  const quiet = cards.filter(
    card => card.rank >= QUIET_LEAD_MIN && card.rank <= QUIET_LEAD_MAX
  );
  return quiet.length ? lowestLead(quiet, ctx) : natural;
}

// 「对手在这门求过件、而且还没逼完」—— 这门我不主动去领。Glen：
//   「对手在求某一门牌，正常来说我们这边不能帮他们求，也就是说一般不主动打
//     这个花色，让他们出，因为这样我方是有优势的，他们出牌我方会最后下。」
// 我去领这门有两重亏：替他把件逼出来，还把「他先出、我方最后下」的位置优势让掉。
//
// 判据用 suitAskSignal（它是「对家优先」的：队友也求过这门就返回 'partner'，
// 那时该走帮队友那条路，不归这里管）。
function opponentAskOpen(view, ctx, suit) {
  return (
    suitAskSignal(view, ctx, suit) === 'opponent' &&
    (view.round?.piecesView?.[suit] ?? []).some(item => item.status === 'unseen') &&
    !teamGavePieceIn(view, ctx, suit)   // 已经交出去了就别再躲，见下
  );
}

// 「我方在对手求件的那一墩把件交了出去」—— Glen 给的后手：
//   「不得以或是砍大分出的话，就要再吊对手可以甩花色。」
// 件已经喂出去了，这门他多半能甩了，再藏着不领没有意义 ——
// 只能反过来主动领这门，一张一张把他能甩的长度压短。
function teamGavePieceIn(view, ctx, suit) {
  for (const trick of view.round?.trickHistory ?? []) {
    if (trick.leadSuit !== suit) continue;
    if (trick.leadSeat % 2 === view.you.team) continue;          // 得是对手在求
    if (!isPieceRequestLead(trick.plays?.[0]?.cards ?? [], ctx)) continue;
    const gave = (trick.plays ?? []).some(play =>
      play.seat % 2 === view.you.team &&
      (play.cards ?? []).some(
        card => suitOf(card, ctx) === suit && isSidePiece(card, ctx)
      )
    );
    if (gave) return true;
  }
  return false;
}

// 「这门我方已经在求件、而且还没逼完」—— 这时候接着领小牌不是乱求，
// 正是 Glen 第 2 条要的【帮队友把别人的件逼出来】，一分都不该罚。
// 判据和 partnerRequest ① 那段一致：我方有人在这门求过 + 还有件没现身。
function helpingTeamAsk(view, ctx, suit) {
  return (
    teamAskedPieceBefore(view, ctx, suit, view.you.seat % 2) &&
    (view.round?.piecesView?.[suit] ?? []).some(item => item.status === 'unseen')
  );
}

// 「这一手打出去会被读成求件，可我并没有这个意思」。
//
// quietLead 换牌只在这门手上还有 6~9 时才成立。实测（100 局插桩）：没有甩牌
// 欲望却还是喊出求件的 135 次里，116 次这门手上【一张 6~9 都没有】—— 大多是
// 只剩一两张的门。那种局面换不了牌，只能换门。
function straySignal(view, ctx, cards, tuning) {
  if (cards.length !== 1) return false;                  // 甩牌不是求件信号
  const card = cards[0];
  const suit = suitOf(card, ctx);
  if (suit === 'TRUMP') return false;                    // 领主牌不是求件信号
  if (!isPieceRequestLead([card], ctx)) return false;    // 本来就不会被读成求件
  if (suitThrowAmbition(view, ctx, suit, tuning)) return false;  // 真心在求，该喊
  return !helpingTeamAsk(view, ctx, suit);                      // 帮队友逼件，该喊
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

// 手上【原本就有牌】的副牌门 —— 埋底搜索的不变量，按 hand 记忆化。
// 同一次 improveKittyPlan 里 hand 始终是同一个数组对象，所以 WeakMap 正好。
const HAND_SUIT_CACHE = new WeakMap();
function handSuitPresence(hand, ctx) {
  let byCtx = HAND_SUIT_CACHE.get(hand);
  if (!byCtx) { byCtx = new Map(); HAND_SUIT_CACHE.set(hand, byCtx); }
  const key = `${ctx.trumpSuit}-${ctx.rankCard}`;
  const cached = byCtx.get(key);
  if (cached) return cached;
  const suits = SUITS.filter(
    suit => suit !== ctx.trumpSuit && cardsOfSuit(hand, suit, ctx).length > 0
  );
  byCtx.set(key, suits);
  return suits;
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
  // ⚠️ 「这门原本有几张」只跟 hand 有关，跟埋哪几张无关 —— 是搜索的不变量。
  // improveKittyPlan 一局要评分两千多次，原来每次都把 33 张手牌按三门重数一遍，
  // 两千多次算的都是同一个答案。按 hand 记忆化（同一次搜索里 hand 是同一个数组）。
  const voidValue = handSuitPresence(hand, ctx)
    .reduce((sum, suit) => sum + (cardsOfSuit(retained, suit, ctx).length === 0 ? 320 : 0), 0);
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

  // 朋友领小牌是求件；领副 K 是强烈求 A。
  // 求件指令高于普通走分（+700 的约定加分）：即使朋友当前暂时领先，
  // 也先把他要的件贡献出来 —— 正因为这条压得过一切，它的触发条件必须严。
  //
  // ⚠️ 原来写的是 `cardPoints(leadCard) > 0 || !isSidePiece(leadCard, ctx)`，
  // 等于【朋友单张领这门、只要不是副 A，就算求件】——6、7、8、9、J、Q 全算。
  // 这是 Glen 说的「件还是容易打出来」的真正出处：约定加分 700 稳压亮件代价，
  // 而且下面的排序是 rank 从大到小，先交出去的还是 A。
  // 实测「有得选却把件交出去」2443 次决策里，纯亏的那 68 次全是被这条推出去的
  //（评分本来是负的，靠 priorBonus 翻上来）。
  //
  // 求件的判据全项目只有一个：isPieceRequestLead —— 单张、本身不是件、
  // 5 以下或者 10（Glen：「第一轮求件是需要打 5 以下」）。这里改成用同一个，
  // 外加「领副 K 求 A」这个更具体的请求。
  // 再叠上一次性规则：我方在这门已经求过，就不存在新的求件。
  const asksForPiece =
    isPieceAskLead(lead.cards, ctx) &&
    !teamAskedPieceBefore(view, ctx, lead.playSuit, view.you.seat % 2);
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

  // 「随手出最便宜的无分牌」只在这两种情形下才对：
  //   ① 朋友已经封住这门（partnerControlSecure）—— 上面走分那条没命中说明手上
  //      没分可送，那就不必浪费大牌，这一墩本来就是我方的
  //   ② 最后一家已知断门 —— 他要毙就毙，我压得再大也拦不住，白扔一张大牌
  //
  // ⚠️ 这里原来写的是 `if (!asksForPiece)` —— 只要朋友领的不是求件牌就一律
  // 走这条，把下面整段【第三手封门】截得完全够不着（朋友领 6/7/8/9/J/Q 全落这里）。
  // Glen 第四次提这件事：
  //   「第三家的出牌，在保证不乱出鬼、主 2 或是件的前提，还是要尽量吃大一些，
  //     避免第四家容易吃分。比如前两家都是小于 10 的，第三家还是尽量吃 10 以上，
  //     不然第四家就容易用 10 吃分。」
  // 实测 200 局：第三家「前两手都不到 10、手上有非件的 J/Q」402 次，
  // 其中 204 次打了小牌，96 次第四家当场用 10 拿走。
  if (partnerControlSecure || lastKnownVoid) {
    return sameSuitChoices
      .filter(choice => choice.pointValue === 0)
      .sort((a, b) => a.preserveCost - b.preserveCost)[0] ?? null;
  }

  // 第三手封门：尽量用大的无分牌压过第二家，让最后一家不能随手塞 5/10/K。
  // 若真的压不过，就出最大无分牌如实表示自己这门很弱。
  //
  // ⚠️ 件要排除在外 —— 这是 Glen 给的前提（「在保证不乱出鬼、主 2 或是件的前提」）。
  // 副 A 是 0 分，不排的话按强度降序排第一个就是它，等于用封门的名义把件送出去。
  // 鬼和主 2 不用管：这个函数对主牌领牌直接返回 null，它们进不了 sameSuitChoices。
  // 一门里只剩件可用时宁可不封，退回最便宜的那张。
  const noPointChoices = sameSuitChoices.filter(
    choice => choice.pointValue === 0 && !isSidePiece(choice.cards[0], ctx)
  );
  // 注：这里【不需要】再筛一层「能拿下这一墩的那些」。推得出它恒等：
  // 按强度降序取第一张就是这门里最大的那张无分非件牌；它要么压得过场面
  //（那它自己就在「能拿下」那一组里，而且还是那组里最大的），要么压不过
  //（那就没有任何一张压得过，筛完是空集，照样退回全集）。两条路结果一样。
  // 原来写着那一层，变异测试删掉它一条测试都不红 —— 不是没测到，是恒等。
  const pool = noPointChoices;
  if (pool.length > 0) {
    return pool.sort((a, b) =>
      cardStrength(b.cards[0], ctx) - cardStrength(a.cards[0], ctx) ||
      a.preserveCost - b.preserveCost
    )[0];
  }
  // 无分的非件牌一张都没有 —— 别为了封门去动件，退回最便宜的无分牌（多半就是件）
  // 交给通用评分器去权衡；它那边有完整的亮件代价。
  if (!asksForPiece) {
    return sameSuitChoices
      .filter(choice => choice.pointValue === 0)
      .sort((a, b) => a.preserveCost - b.preserveCost)[0] ?? null;
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
  const history = view.round?.trickHistory ?? [];

  // 队友【最近一次领牌】就是他现在的计划 —— 这条是 Glen 定的：
  //   「队友吃大然后打其它牌，证明他有其它计划，正常不应该帮他再逼件，
  //     他也有可能是暗求。」
  // 能领牌就说明他刚吃下一墩，那一领是他拿着牌权做的选择。他换了门，
  // 之前那门的请求就作废；他改吊主，说明走的是主牌路线，更不该由我去回副牌。
  let lastIndex = -1;
  for (let i = 0; i < history.length; i += 1) {
    if (history[i].leadSeat === partnerSeat) lastIndex = i;
  }
  const last = lastIndex >= 0 ? history[lastIndex] : null;
  if (!last || last.leadSuit === 'TRUMP') return null;
  const suit = last.leadSuit;
  if (cardsOfSuit(view.you.hand ?? [], suit, ctx).length === 0) return null;
  const partnerIsDeclarer = partnerSeat === view.declarerSeat;

  // ============ ① 这门上还没逼完的求件：意图【跨墩有效】 ============
  // Glen：「即使自己没件，也需要帮队友把别人的件逼出来，因为这个时候
  //        你并不知道你的队友有多少支、对手有多少支，只能跟着打。」
  // 所以判断的不是「我还剩不剩件」，是【这门还有没有件没现身】。
  //
  // ⚠️ 跨墩只在【同一门】里跨：他第 3 墩用 ♠4 求件、第 6 墩又领 ♠9，
  // 那次求件仍然算数（他没换计划，只是牌权回到手上接着打）。
  // 但他第 6 墩领的是别的门 —— 上面那段已经把 suit 换成新的那门了，
  // 旧的那次求件到此为止。这两半是 Glen 前后两句话，缺一不可：
  //   c6543a2 只实现了「跨墩」，把「换门就作废」一起丢了；
  //   再往前那一版只看最近一领，把「同门跨墩」丢了。
  //
  // 停止条件是「一支未现的件都没有了」：件已经逼完，接下来该甩而不是接着领。
  const items = view.round?.piecesView?.[suit] ?? [];
  if (items.some(item => item.status === 'unseen')) {
    for (let i = lastIndex; i >= 0; i -= 1) {
      const trick = history[i];
      if (trick.leadSeat !== partnerSeat || trick.leadSuit !== suit) continue;
      if (!isPieceAskLead(trick.plays?.[0]?.cards ?? [], ctx)) continue;
      return { suit, seeking: true, partnerIsDeclarer };
    }
  }

  // ============ ② 这门上没有未了的求件：只是把牌权还给他这门 ============
  const cards = last.plays?.[0]?.cards ?? [];
  return {
    suit,
    // 「回队友这门」这个意图一直成立，但【求件】只算我方在这门的第一次。
    // 他贡献完件再领一张小牌，那不是在求件，是牌权到手随手往回打。
    seeking:
      cards.length > 0 && cards.every(card => card.rank <= 5) &&
      !teamAskedPieceBefore(view, ctx, suit, view.you.seat % 2, lastIndex),
    partnerIsDeclarer,
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

  const askedForPiece = isPieceAskLead(lead.cards, ctx);
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

// 对手在这一门【已经甩得动了】—— Glen 裁定压缩优先级时用的判据：
//   「如果判断对手可以甩牌了，应该先去压 ♠ 的长度，因为此时对手甩牌的威胁
//     比你去给队友件要更大，对手可以甩的牌短一支，那就少一份威胁。」
//
// 判据按【最坏情况】算，两条同时成立：
//   · 这门我手上再没有件能挡他 —— piecesView 的 'mine' 是我自己的件，
//     'unseen' 有可能在队友手上，但那是猜。防守判断不该指望队友，只认我自己的。
//   · 他估计还有 ≥2 张 —— 甩牌至少两张，估不到两张就谈不上威胁。
// 注意这【不是】canThrowByStatus：那条是从「我自己甩得成吗」的角度写的，
// 我手上的件不挡我自己，却实打实地挡对手。方向相反，别复用。
function opponentThrowReadyIn(view, ctx, suit) {
  const items = view.round?.piecesView?.[suit] ?? [];
  if (items.length === 0) return false;
  if (items.some(item => item.status === 'mine')) return false;
  return maxOpponentSuitEstimate(view, ctx, suit) >= 2;
}

function opponentThreatSuit(view, ctx, tuning = strategyTuning(view)) {
  const scores = new Map();
  for (const trick of view.round.trickHistory ?? []) {
    if (trick.leadSeat % 2 === view.you.team || trick.leadSuit === 'TRUMP') continue;
    const amount = trick.leadType === 'throw' ? 5 : 1;
    scores.set(trick.leadSuit, (scores.get(trick.leadSuit) ?? 0) + amount);
  }
  // 我方在哪一门被迫把件交给了求件的对手，哪一门就直接算威胁门（Glen 的后手，
  // 判据见 teamGavePieceIn）—— 不必再等他领够两次才反应。
  for (const suit of SUITS.filter(item => item !== ctx.trumpSuit)) {
    if (!teamGavePieceIn(view, ctx, suit)) continue;
    scores.set(suit, (scores.get(suit) ?? 0) + tuning.opponentThreatThreshold);
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
// 对手在求这门时，桌上要有多少分才值得把件砍出去。
// Glen：「除非有大分，比如 20 分以上……才能把件出给别人。」
const PIECE_ASK_BIG_POINTS = 20;
// 这门外面还剩多少分，才值得为了护件放走桌上的分（见 coverNeedsFirstPiece）。
const PIECE_COVER_MIN_POINTS = 30;
// 打完这一支之后这门至少还得剩几张 —— 顶端再大，只剩一张也压不住两张的甩牌。
//
// ⚠️ 「Q 或是 J 多」的「多」这里【不】读成「同一档有两三张」。两种读法都实测过：
// 要求同档两张时，400 局里只剩 12 次机会（顶端在手的局面本来有 314 次），
// 等于写了条死规则；而 Glen 给的目的是「别人的甩牌自己可能可以大」——
// 那要的是【顶端在我手上 + 还剩得够长】，不是一个对子。
const PIECE_FORCE_MIN_LEFT = 2;

// 「砍下去就保不了底、而且分还没到移庄线」时，放走这一墩的分量。
// 要压得过接管加分（最后一家时是 100 + 分×10 + 45），否则拦不住。
const OVER_KILL_PENALTY = 1200;

// 本局策略对领牌的加权。数值挑在「够翻得动兜底选项、但压不过约定打法」这个区间：
// develop-long-side-suit 本身 160，加上之后 360 —— 高过 attack-opponent-long-suit(250)，
// 仍低于 seek-piece(450) 和各种约定（620+），不会把 Glen 定过的那些打法盖掉。
const STRATEGY_RUN_SIDE_BONUS = 200;

// ⚠️ 按 view 记忆化：一次决策里跟牌打分对每个候选都会问一次，
// 而它每次都要把整局历史 flatMap 一遍。view 每次决策都是新对象，所以用 WeakMap。
const PLAYED_CACHE = new WeakMap();
function playedCardsOf(view) {
  const cached = PLAYED_CACHE.get(view);
  if (cached) return cached;
  const value = playedCardsUncached(view);
  PLAYED_CACHE.set(view, value);
  return value;
}

function playedCardsUncached(view) {
  return [
    ...(view.round?.trickHistory ?? []).flatMap(trick =>
      (trick.plays ?? []).flatMap(play => play.cards ?? [])
    ),
    ...(view.round?.currentTrick ?? []).flatMap(play => play.cards ?? []),
  ];
}

// 主牌分档模板：strength → 这一档总共几张。只跟 ctx 有关，按 ctx 记忆化。
const TRUMP_TIER_CACHE = new Map();
function trumpTierTemplate(ctx) {
  const key = `${ctx.trumpSuit}-${ctx.rankCard}`;
  const cached = TRUMP_TIER_CACHE.get(key);
  if (cached) return cached;
  const counts = new Map();
  for (const card of buildDeck()) {
    if (suitOf(card, ctx) !== 'TRUMP') continue;
    const strength = cardStrength(card, ctx);
    counts.set(strength, (counts.get(strength) ?? 0) + 1);
  }
  const template = [...counts.entries()];
  TRUMP_TIER_CACHE.set(key, template);
  return template;
}

export function assessBottomControl(view, ctx) {
  const hand = view.you?.hand ?? [];
  const myTrumps = cardsOfSuit(hand, 'TRUMP', ctx);

  // 把整副牌里的主牌按强度分档，统计每档 total / mine / played。
  // ⚠️ 「每一档总共几张」只跟 ctx（主花色 + 级牌）有关，与手牌、出牌都无关，
  // 所以按 ctx 缓存一份模板，每次只把 mine/played 填进去（至多 52 份）。
  // 原来每次调用都 buildDeck() 造 108 张牌重数一遍，而这个函数在跟牌打分里
  // 是按【每个候选】调用的。
  const tiers = new Map();
  for (const [key, total] of trumpTierTemplate(ctx)) {
    tiers.set(key, { total, mine: 0, played: 0 });
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

// 两副牌里主牌恒 36 张、每门副牌恒 24 张 —— 与主花色、级牌是哪一档【无关】
//（52 种组合验证过：2 大鬼 + 2 小鬼 + 2 主级牌 + 6 副级牌 + 24 张主花色普通牌 = 36；
//  副牌门 = 13 个点数 × 2 − 升为主牌的那 2 张级牌 = 24）。
// ⚠️ 原来这几处各自 buildDeck() 再 filter 一遍来数这个常数 ——
// 5 局要造一百多万张临时牌，纯属浪费，而且把「这是个常数」这件事藏起来了。
const TOTAL_TRUMPS = 36;
const TOTAL_PER_SIDE_SUIT = 24;

// 场上还有多少张主牌没露面（不含我手上的；底牌里的仍算未知，故偏高）
function outstandingTrumpCount(view, ctx) {
  const played = playedCardsOf(view).filter(card => suitOf(card, ctx) === 'TRUMP').length;
  const mine = cardsOfSuit(view.you?.hand ?? [], 'TRUMP', ctx).length;
  return Math.max(0, TOTAL_TRUMPS - played - mine);
}

// 这一手主牌【还有没有人压得过】—— 只看公开信息：
// 比我这手最大那张更强的主牌，扣掉已经现身的、扣掉还攥在我自己手里的，
// 一张不剩，那这一墩就已经是我的了。
//
// ⚠️ 只算【严格更大】的：同强度后出者不大（server/trick.js 用「严格大于才换赢家」
// 实现先出者大），所以同档的牌威胁不到我。
// 底牌里的牌算不出来，一律当成还在对手手上 —— 偏保守，宁可少豁免。
function unbeatableTrumpPlay(view, ctx, cards) {
  if (cards.length === 0) return false;
  let mine = -Infinity;
  for (const card of cards) {
    if (suitOf(card, ctx) !== 'TRUMP') return false; // 不是满手主牌，谈不上压不压
    mine = Math.max(mine, cardStrength(card, ctx));
  }
  let above = 0;
  for (const [strength, total] of trumpTierTemplate(ctx)) {
    if (strength > mine) above += total;
  }
  if (above === 0) return true;
  for (const card of playedCardsOf(view)) {
    if (suitOf(card, ctx) === 'TRUMP' && cardStrength(card, ctx) > mine) above -= 1;
  }
  for (const card of view.you?.hand ?? []) {
    if (suitOf(card, ctx) === 'TRUMP' && cardStrength(card, ctx) > mine) above -= 1;
  }
  return above <= 0;
}

// 「求件」的领牌长什么样（Glen：「第一轮求件是需要打 5 以下，甚至 10 也可以」）。
// 单张、不是件本身、点数很小或是 10 —— 这就是在跟同伴要件。
// 反过来「如果不想对家把件很快放出来，千万第一轮不打 5 以下」：
// 领大牌不算求件，别人也不该按求件来应答。
// 「求件」是一次性的表态，不是一门牌的永久属性（Glen 实战反馈①）：
//   「一方 BOT 求了个件，对方打出来后又打了个 5 以下，其实这个时候已经不代表
//     求件了，因为之前对家已经求过……我似乎看到他们互出件，然后给我方甩牌。」
//
// 我方在一门副牌上只有【一次】求件机会：第一次领小牌是在问「你有没有件」，
// 队友答过之后，同门再领小牌就只是普通打法。再当成求件去贡献，就是白白把
// 一支「未现」变成「已现」—— canThrowByStatus 只要求每支件都 !== 'unseen'，
// 两个人来回互贡献，等于替【攥着这门长牌的那家】凑齐甩牌资格，而三家里两家是对手。
//
// 实测 400 局：第 2 次求件贡献了 185 次，第 3 次及以后又贡献 21 次。
function teamAskedPieceBefore(view, ctx, suit, team, beforeIndex = Infinity) {
  const history = view.round?.trickHistory ?? [];
  const limit = Math.min(history.length, beforeIndex);
  for (let i = 0; i < limit; i += 1) {
    const trick = history[i];
    if (trick.leadSuit !== suit || trick.leadSeat % 2 !== team) continue;
    if (isPieceRequestLead(trick.plays?.[0]?.cards ?? [], ctx)) return true;
  }
  return false;
}

// 「队友这一领是不是在求件」—— 全项目唯一的判据，别再各写一份。
// 两种形态：
//   ① 单张小牌：≤5，或者 10（10 也是求的意思，但白送 10 分，
//      只在手上没有 ≤5 的牌时才用 —— 代价大，所以是次选）
//   ② 领副 K：K 本身就是件，这是强烈求 A
// ⚠️ 曾经有三处各写一套，最松的那套是
//    `cardPoints > 0 || !isSidePiece` —— 队友领任何非件小牌都算求件，
//    6/7/8/9/J/Q 全算。求件带 +700 的约定加分，判据一松就到处乱给件。
function isPieceAskLead(cards, ctx) {
  if (!Array.isArray(cards) || cards.length !== 1) return false;
  const card = cards[0];
  return (
    isPieceRequestLead(cards, ctx) ||
    (isSidePiece(card, ctx) && cardPoints(card) > 0)
  );
}

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
// 从中读出「我一直在执行哪个策略」给它加权就够了（lastLeadStyle 就是干这个的）。
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

export function roundStrategy(view, ctx, control = bottomControlOf(view, ctx)) {
  const role = leadRole(view);
  const trumps = cardsOfSuit(view.you?.hand ?? [], 'TRUMP', ctx);
  const plan = tailThrowPlan(view, ctx, control);
  const style = lastLeadStyle(view, view.you?.seat);

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
// 某个座位最近一次领牌走的是主牌还是副牌 —— 「他在走什么路子」的唯一判据。
// 两个用处：跟庄家的路子（declarerSeat），以及本局策略的惯性（自己的座位）。
// ⚠️ 原来这是两个一模一样、只差看哪个座位的函数（declarerLeadStyle / myLeadStyle）。
// 「对手正在吊主」—— 最近一次领主牌是不是对手领的。
// Glen：「如果对方要吊主吊大牌出来让自己保底，或是吊短主牌可以让自己的甩牌
//   别人毙不到，那我方记着不能帮对方吊主；当然也有例外，就是自己的主牌
//   碾压式的强，可以反吊回去。」
// 他吊主是在替自己办两件事（把顶端逼出来做保底 / 把主削光让自己的甩牌毙不到），
// 我跟着吊就是替他办 —— 而且一轮吊下来我方也少一张。让他自己吊。
function opponentDrawingTrumps(view) {
  const history = view.round?.trickHistory ?? [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].leadSuit !== 'TRUMP') continue;
    return history[i].leadSeat % 2 !== view.you.team;
  }
  return false;
}

function lastLeadStyle(view, seat) {
  if (seat === null || seat === undefined) return null;
  const leads = (view.round?.trickHistory ?? []).filter(trick => trick.leadSeat === seat);
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
  const total = TOTAL_PER_SIDE_SUIT;
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

// 这门【还有多少分没现身】—— 对手把这门甩出来能刮走多少分。
//
// Glen 对「这门还长、外边一件没出，该不该亮件」给的例外：
// 「但也有例外，比如说打 10 或打 K，如果判断现在即使对方甩了也得不了多少分，
//   那么就可以杀。」
//
// ⚠️ 不写死「打10 / 打K」，写成【这门还剩多少分】—— 打 10 或打 K 时该门的
// 10 / K 升为主牌，这门天生就少 20 分（50 → 30，实测过），正是他举的例子；
// 而到了中后段分被吃掉一部分，道理完全一样。一个量把两种情形都覆盖了。
const SIDE_SUIT_MAX_POINTS = 50;   // 一门副牌满打满算的分（两副牌：5/10/K 各两张）
// 分全没了也不是零风险 —— 他甩一手长的照样把牌权和墩数拿走。
const SUIT_POINTS_FLOOR = 0.4;

const SIDE_POINTS_CACHE = new Map();
function sideSuitTotalPoints(ctx) {
  const key = `${ctx.trumpSuit}-${ctx.rankCard}`;
  const cached = SIDE_POINTS_CACHE.get(key);
  if (cached !== undefined) return cached;
  const suit = SUITS.find(item => item !== ctx.trumpSuit);
  const total = buildDeck()
    .filter(card => suitOf(card, ctx) === suit)
    .reduce((sum, card) => sum + cardPoints(card), 0);
  SIDE_POINTS_CACHE.set(key, total);
  return total;
}

function suitPointsAtLarge(view, ctx, suit) {
  const seen = playedCardsOf(view)
    .filter(card => suitOf(card, ctx) === suit)
    .reduce((sum, card) => sum + cardPoints(card), 0);
  const mine = cardsOfSuit(view.you?.hand ?? [], suit, ctx)
    .reduce((sum, card) => sum + cardPoints(card), 0);
  return Math.max(0, sideSuitTotalPoints(ctx) - seen - mine);
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

// 「逼件」的资格 —— Glen 的「第三家 10 分要不要打 A 封」里的第 2 种情况：
//   「如果此门副牌不长，但也不短，大概 5 张，没有出过件的情况，最好也是不杀，
//     风险一样，如果判断件有可能在自己对家，然后自己还有大牌，比如 Q 或是 J 多，
//     可以逼别人的件出来的情况，特别是别人可能只剩一件，逼出来之后，
//     别人的甩牌自己可能可以大，也可以杀。」
//
// 「Q 或是 J 多」的「多」不去猜几张算多，照他给的【目的】写 ——
// 「逼出来之后，别人的甩牌自己可能可以大」：
//   · 件全部逼出来之后，这门的顶端得还在我手上（比我大的非件牌外面一张不剩）
//   · 而且打完之后这门还剩得够长，压得住对手甩出来的多张
function forcesPiecesOut(view, ctx, suit, cards) {
  const spent = new Set(cards.map(card => card.id));
  const rest = cardsOfSuit(view.you?.hand ?? [], suit, ctx)
    .filter(card => !spent.has(card.id) && !isSidePiece(card, ctx));
  // 至少还得剩两张，才压得住对手两张的甩牌；只剩一张只能压单张。
  if (rest.length < PIECE_FORCE_MIN_LEFT) return false;
  let top = 0;
  for (const card of rest) if (card.rank > top) top = card.rank;
  for (let rank = top + 1; rank <= 14; rank += 1) {
    const probe = { id: `force-${suit}-${rank}`, suit, rank };
    if (suitOf(probe, ctx) !== suit) continue;
    if (isSidePiece(probe, ctx)) continue; // 件本来就是要被逼出来的，不算威胁
    if (unseenCopiesOf(view, suit, rank, ctx) > 0) return false;
  }
  return true;
}

// 这一墩要封住最后一家，我手上唯一压得过去的是这门【还没现过的第一支件】吗？
// 是的话，Glen 裁定这一墩就不必封 —— 亮出第一支件等于把这门的甩牌资格从零推起来，
// 比桌上那点分重得多。例外见 forcesPiecesOut。
//
// 只在 lastSeatPointExposure 会返回非零的那个形状里才有意义（第三家、首家单张、
// 副牌墩），所以先按同一组前提短路掉，免得每个候选都白算一遍。
// 这是【一墩一次】的事实，却在 scoreFollow 里按每个候选问一遍 ——
// 和 bottomControlOf / playedCardsOf 一样按 view 记忆化。
const COVER_FIRST_PIECE_CACHE = new WeakMap();
function coverNeedsFirstPiece(view, ctx) {
  const cached = COVER_FIRST_PIECE_CACHE.get(view);
  if (cached !== undefined) return cached;
  const value = coverNeedsFirstPieceUncached(view, ctx);
  COVER_FIRST_PIECE_CACHE.set(view, value);
  return value;
}

function coverNeedsFirstPieceUncached(view, ctx) {
  const current = view.round?.currentTrick ?? [];
  const lead = current[0];
  if (current.length !== 2 || !lead || lead.playSuit === 'TRUMP' || lead.cards.length !== 1) {
    return false;
  }
  const items = view.round?.piecesView?.[lead.playSuit] ?? [];
  if (items.length === 0) return false;
  if (!items.some(item => item.status === 'unseen')) return false; // 全现了，无所谓
  if (items.some(item => item.status === 'seen')) return false;    // 已经有人开过头了
  // Glen 的另一条例外（第 1 种情况里给的，第 2 种同理）：
  //   「比如说打 10 或打 K，如果判断现在即使对方甩了也得不了多少分，那么就可以杀。」
  // 护件是为了不让对手甩这门刮分，这门本来就没多少分可刮时就不必护。
  // 门槛用 30 分不是拍的：打 10 / 打 K 时该门的 10 或 K 升为主牌，
  // 这门【天生】就从 50 分掉到 30 分 —— 那正是 Glen 举的两个例子。
  if (suitPointsAtLarge(view, ctx, lead.playSuit) <= PIECE_COVER_MIN_POINTS) return false;
  // 要的是【稳稳封得住】的牌：压得过眼前的牌面，而且这门没有更大的牌还没现身。
  // ⚠️ 只看「压得过眼前」不够 —— 手上 A Q J 10 时 Q、J 也压得过桌面，
  // 但外面还有未现的 K/A，最后一家照样反超。那种「封不牢的封」不算数，
  // 否则这条裁定在最常见的牌型（A 带一串 Q J 10）上直接失效。
  const mine = cardsOfSuit(view.you?.hand ?? [], lead.playSuit, ctx);
  const covers = mine.filter(card => {
    if (trickLeader([...current, { seat: view.you.seat, cards: [card] }], ctx)?.seat
        !== view.you.seat) return false;
    for (let rank = card.rank + 1; rank <= 14; rank += 1) {
      const probe = { id: `cover-${lead.playSuit}-${rank}`, suit: lead.playSuit, rank };
      if (suitOf(probe, ctx) !== lead.playSuit) continue;
      if (unseenCopiesOf(view, lead.playSuit, rank, ctx) > 0) return false;
    }
    return true;
  });
  if (covers.length === 0) return false;                 // 本来就封不牢，不用谈
  // 注：这里【不需要】再问一句「有没有不是件的牌也能封牢」——
  // 任何非件的牌之上都压着这门的件，而上面已经要求「还有件没现身」，
  // 所以能封得牢的必然全是件。写了那一句变异测试也杀不掉（它恒真）。
  // 例外（Glen）：件可能在对家，而且逼出来之后这门的顶端还在我手上 —— 那就该杀
  if (
    suitAskSignal(view, ctx, lead.playSuit) === 'partner' &&
    forcesPiecesOut(view, ctx, lead.playSuit, covers)
  ) return false;
  return true;
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
// 「这一墩是对手在甩牌」—— Glen 给的第二个例外，他点名说这个很危险：
//   「还有一种情况是此次是对手甩的牌，有可能出了 A 后，他可以顺手再甩一次长的，
//     这个也很危险，也是需要计算当前出的牌去判断可能性。」
// 甩牌这个动作本身就是在宣告「我这门长、而且我算准了你们跟不了」。
// 这时候把一支件垫进去，正是给他下一手甩牌铺路。
// 注：不分「甩的是副牌还是主牌」。主牌甩牌同样是在明示手上有长门，道理一样；
// 而且真要分，也构造不出能钉住那个分支的局面 —— 主牌甩牌时我手上但凡有主就
// 必须跟主，轮不到垫牌，没主可跟时手里又几乎不可能让一支副 A 排进最便宜的那几张。
function opponentThrowInProgress(view) {
  const lead = view.round?.currentTrick?.[0];
  return !!lead && (lead.cards?.length ?? 1) > 1 && lead.seat % 2 !== view.you.team;
}

// 【对手在求这门，件就不能随手砍出去】—— Glen 2026-08-29 第三次点名：
//   「BOT 现在还是容易乱砍件，特别是有 K 的时候，不考虑是谁求的件，经常是
//     即使对手求的件，有 A 或者 10 分 15 分就砍了，不考虑后果。」
//
// 口径是他早先给全的那三档：
//   「对手求件，一般情况下不能轻易出件，如果有两件可以砍，只有一件的话，
//     一般不能出，除非有大分，比如 20 分以上，或是自己没剩多少如三支甚至两支，
//     才能把件出给别人……如果不是这些情况，一般不把件出给对手。」
//
// ⚠️ 这三档【原来就写在 pieceExposureRisk 的打分里】，而且注释信誓旦旦说
// 「等效门槛落在 25 分上下」—— 那个推算是错的，错在拿 exposureRisk = 1 去算：
// 它其实是 clamp(threat,0.5,2) × read × stake 三个系数【相乘】，
// 实测（scripts/audit/piece-cost-probe.mjs，100 局 890 次）中位数只有 0.44，
// 代价中位 106 而不是 240；而接管加分是 100 + 桌上分×10，于是
//   桌上  0 分 → 47% 的场合加分就已经压得过代价
//   桌上 10 分 → 80%
//   桌上 15 分 → 91%
// 正好就是 Glen 描述的「有 A 或者 10 分 15 分就砍了」。
//
// 所以这一条只能【删候选】，不能靠打分 —— 同一张牌上接管加分、送分给队友、
// 保底加分是累加的，要罚得动就得罚成一票否决，那会顺手压垮别的打法。
// 打分那一头照旧留着（它管的是「没人求 / 队友求」那两种更软的局面）。
function pieceOwedToOpponentAsk(view, ctx, cards) {
  const hand = view.you?.hand ?? [];
  // 「除非有大分，比如 20 分以上」—— 桌上已经摆着的分，不含我自己这一手：
  // 我那支 K 的 10 分是我【付出】的，不是奖品。
  const tablePoints = (view.round?.currentTrick ?? [])
    .flatMap(play => play.cards ?? [])
    .reduce((sum, card) => sum + cardPoints(card), 0);
  if (tablePoints >= PIECE_ASK_BIG_POINTS) return false;
  for (const card of cards) {
    if (!isSidePiece(card, ctx)) continue;
    const suit = suitOf(card, ctx);
    const items = view.round?.piecesView?.[suit] ?? [];
    // 件全现完了，亮不亮都一样
    if (!items.some(item => item.status === 'unseen')) continue;
    // 只管【对手】在求的门。队友求 → Glen：「如果对家有表示，可以很没压力地出件」
    if (suitAskSignal(view, ctx, suit) !== 'opponent') continue;
    // 「有两件可以砍」
    if (items.filter(item => item.status === 'mine').length >= 2) continue;
    // 「即使对方甩了也得不了多少分，那么就可以杀」—— Glen 早先给的例外，
    // 这道闸不能把它一起挡掉。量用的是这门【外面还剩多少分】，和打分那一头的
    // stake 同源；门槛借现成的 PIECE_COVER_MIN_POINTS（30），不另造魔数 ——
    // 它本来的意思就是「这门还剩多少分才值得为了护件放走桌上的分」，同一件事。
    // ⚠️ 打 10 / 打 K 时该门的 10 / K 升主，这门天生就从 50 掉到 30，
    // 正是 Glen 举的那两个例子，一个量覆盖两种情形。
    if (suitPointsAtLarge(view, ctx, suit) <= PIECE_COVER_MIN_POINTS) continue;
    // 「或是自己没剩多少如三支甚至两支」—— 口径同 PIECE_NEAR_VOID_AFTER，
    // 按【打完这一手之后】还剩几张算，和打分那一头保持一致。
    const spentHere = cards.filter(item => suitOf(item, ctx) === suit).length;
    if (cardsOfSuit(hand, suit, ctx).length - spentHere <= PIECE_NEAR_VOID_AFTER) continue;
    return true;
  }
  return false;
}

function pieceExposureRisk(view, ctx, cards, partnerAskedSuit, tuning) {
  const hand = view.you?.hand ?? [];
  const throwing = opponentThrowInProgress(view);
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
    // 【对手求件时到底能不能出件】—— Glen 把口径说全了：
    //   「对手求件，一般情况下不能轻易出件，如果有两件可以砍，只有一件的话，
    //     一般不能出，除非有大分，比如 20 分以上，或是自己没剩多少如三支甚至两支，
    //     才能把件出给别人……如果不是这些情况，一般不把件出给对手。」
    //
    // 三档都【已经在这个函数里了】，不用另写（scripts/audit/loose-piece.mjs 逐条量过，
    // 200 局里不合这套口径的只有 1 次）：
    //   · 「有两件可以砍」→ 两件在手时接管加分本来就压得过这里的代价，
    //     实测四张配两件、桌上 10 分就会砍。⚠️ 试过显式加一条 `held >= 2` 豁免，
    //     任何局面都不改变结果（合规数 33 → 34，是噪声），按惯例撤掉了。
    //   · 「有大分 20 分以上」→ 接管加分（100 + 分×10）对上 PIECE_EXPOSURE_COST(240)，
    //     等效门槛落在 25 分上下
    //   · 「自己没剩多少如三支甚至两支」→ 下面 PIECE_NEAR_VOID_AFTER 那条
    //     （打完还剩 ≤2 张 = 手上原本 ≤3 张），和他的措辞正好对上
    if (strongPieceSuit(view, ctx, suit, tuning)) return sum;
    if (partnerAskedSuit === suit) return sum;
    // 「这门快断了」就不罚 —— Glen：「如果自己这门已经快断了，比如打 A 后
    // 再捅多一支或两支就断了，可以毙别人，这个时候也可以吃。」
    //
    // ⚠️ 这里【试过】收紧成「只有真的把这一墩吃下来才豁免」，又退回来了
    //（账在 scripts/audit/loose-piece.mjs）。两条理由：
    //   · 那一版顺带把「队友稳赢、我把 K 的 10 分送过去」也罚掉了，Glen 纠正：
    //     「队友 A，自己如果只剩下 K 和 3，正常还是要把 K 给队友。」
    //   · 去掉那一半之后剩下的差别只有 200 局 5 次，而且构造不出能钉住它的
    //     fixture —— 垫牌位置的候选只有 lowCards / pointCards 两种，一支件只有
    //     在「便宜到没有对手」时才被选中，那时它是唯一候选，罚多少都改不了结果。
    // 要再收紧，得先动候选生成那一头。
    //
    // 唯一的例外是【对手正在甩牌】：那一墩我是在给他凑张数，除非整手主牌毙掉
    // 否则根本吃不下来，「可以吃」这个前提压根不存在，这条豁免自然不成立。
    const spentHere = cards.filter(item => suitOf(item, ctx) === suit).length;
    if (
      !throwing &&
      cardsOfSuit(hand, suit, ctx).length - spentHere <= PIECE_NEAR_VOID_AFTER
    ) return sum;
    const signal = suitAskSignal(view, ctx, suit);
    const threat = maxOpponentSuitEstimate(view, ctx, suit) / PIECE_THREAT_BASELINE;
    const read = signal === 'partner' ? PIECE_READ_PARTNER_ASKED
      : signal === null ? PIECE_READ_NOBODY_ASKED
      : 1;
    // 他甩出来能刮多少分 —— 「即使对方甩了也得不了多少分，那么就可以杀」。
    // ⚠️ 分母是【满分 50】这个常数，不能用 sideSuitTotalPoints(ctx)，
    // 那样打 10 时 30/30 = 1，正好把要表达的效果除没了。
    const stake = Math.max(
      SUIT_POINTS_FLOOR,
      suitPointsAtLarge(view, ctx, suit) / SIDE_SUIT_MAX_POINTS
    );
    return sum +
      Math.min(PIECE_THREAT_MAX, Math.max(PIECE_THREAT_MIN, threat)) * read * stake;
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
  // 「碾压式的强」按算牌落地：顶端在我手上，而且我的主牌比【任何单独一家】
  // 可能持有的都多 —— 那时接着吊是把他削光，不是替他削别人。
  const crushingTrumps =
    control.holdsTopTrump && trumps.length > maxOpponentTrumpEstimate(view, ctx);
  const helpingOpponentDraw = opponentDrawingTrumps(view) && !crushingTrumps;
  if (!opening && !helpingOpponentDraw && drawPool.length > 0 && outstandingTrumps > 0 &&
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
        ? (lastLeadStyle(view, view.declarerSeat) === 'trump' &&
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
    // seeking = 队友明确在求件，我接着领小牌【就是】在帮他逼件，那是有意发的信号；
    // 只是「把牌权还给他这门」时就不该发，走 quietLead。
    const back = cardsOfSuit(hand, request.suit, ctx);
    addProposal(
      [request.seeking ? lowestLead(back, ctx) : quietLead(view, ctx, back, tuning)],
      bonus * tuning.leadStrategyPriorWeight,
      'return-partner-suit'
    );
  }

  // 对手多次从某门领牌/甩牌，主动打该门来压缩他最后的甩牌张数。
  const threatSuit = opponentThreatSuit(view, ctx, tuning);
  if (threatSuit) {
    // 「欠着的那门」单独一档 —— Glen：「不得以或是砍大分出的话，就要再吊对手
    // 可以甩花色。」件已经喂给他了，压他的长度就成了正事，不再只是顺手为之。
    //
    // 400 这个数是【卡在提案分档之间】选的，不是拍的：要压得过
    // develop-long-side-suit 的上限 360（160 + 跑副牌 200）—— 他说的是「就要」，
    // 不能被「发展自己最长的门」盖掉；又要压不动 seek-piece(450) 和帮队友求件
    //（480+），那两条是他反复裁过的对家约定。
    // ⚠️ 「压不动帮队友求件」这半句【只在他还甩不动的时候成立】—— 见下面
    // throwReady 那一档，Glen 后来把这条撞车裁给了防守。
    const owed = teamGavePieceIn(view, ctx, threatSuit);
    // 件已经喂出去、而且他【真的甩得动了】→ 压他的长度反过来压过帮队友求件。
    // Glen 裁定：「此时对手甩牌的威胁比你去给队友件要更大。」
    const throwReady = owed && opponentThrowReadyIn(view, ctx, threatSuit);
    addProposal(
      // 压缩对手的甩牌张数，不是在求件 —— 别顺手把信号发出去
      [quietLead(view, ctx, cardsOfSuit(hand, threatSuit, ctx), tuning)],
      // ⚠️ 这里【故意没有】给「吃分为主」再加一份。试过 +200，变异测试显示它
      // 改变不了任何决策：points-first 时 develop 的加分本来就不适用
      //（那是 run-side 专属），attack(250) 已经稳压 develop(160)。
      // 「打别人不想自己打的牌」这个意思，靠的是【压掉吊主之后 attack 自然胜出】，
      // 不需要第二份加分。它唯一能改变的是和求件(450) 打平，没有依据这么做。
      //
      // 580 同样是【卡在分档之间】选的：要压得过帮队友求件的上限
      //（return-partner-suit 320 + 明求 160 + 队友做庄 80 = 560）和求件(450)，
      // 又要压不动 safe-side-throw(620) —— 我自己能甩就甩是实打实的分，
      // Glen 早裁过，不该被防守挤掉。
      (throwReady ? 580 : owed ? 400 : 250) * tuning.leadStrategyPriorWeight,
      owed ? 'compress-after-giving-piece' : 'attack-opponent-long-suit'
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
    const noPoint = long.filter(card => cardPoints(card) === 0);
    addProposal(
      // 发展长副牌同样不是求件。注意这门【够长的话】quietLead 自己会放行 ——
      // 「很长」本来就是 Glen 认可的甩牌欲望，那时的求件信号是真心的。
      [quietLead(view, ctx, noPoint.length ? noPoint : long, tuning)],
      // 「以跑副牌为主」的两种策略下，发展长副牌不再只是兜底选项
      (160 + (strategy === 'run-side' || strategy === 'run-and-score'
        ? STRATEGY_RUN_SIDE_BONUS : 0)) * tuning.leadStrategyPriorWeight,
      'develop-long-side-suit'
    );
  }

  // 全剩主牌时仍优先留大牌保底/扣底。
  // 兜底也别乱喊：真的没别的可打了才领这张，更没有求件的意思。
  // 只剩主牌时 quietLead 自动退化成 lowestLead（主牌不是求件信号）。
  const fallback = quietLead(view, ctx, nonTrumps.length ? nonTrumps : trumps, tuning);
  if (fallback) addProposal([fallback], 20, 'low-card-fallback');

  // 【对手在求的那门，不主动去领】—— 判据在 opponentAskOpen 上面那段。
  //
  // 例外：这门我自己也有甩牌欲望 —— 那是我的武器，领它是为了自己甩，
  // 不是在帮他逼件，照打。
  //
  // 兜底同下面两段：真的没别的门可领时维持原判（总得领一张出去）。
  {
    const helping = [...proposals].filter(([, proposal]) => {
      if (proposal.cards.length !== 1) return false;
      const suit = suitOf(proposal.cards[0], ctx);
      if (suit === 'TRUMP') return false;
      return opponentAskOpen(view, ctx, suit) && !suitThrowAmbition(view, ctx, suit, tuning);
    });
    if (helping.length < proposals.size) {
      for (const [key] of helping) proposals.delete(key);
    }
  }

  // 【不想求件，就别打出会被读成求件的那张牌】—— Glen 实战反馈第 1 条。
  // 判据在 straySignal 上面，豁免两种「真心在求」的情形。
  //
  // ⚠️ 和下面的甩牌让位一样，用【删提案】而不是【罚分】，理由也一样：
  // addProposal 对同一个 key 是累加的，同一张小牌上
  //   return-partner-suit(320 +队友做庄 80) + develop-long-side-suit(160
  //   +跑副牌 200) + low-card-fallback(20) 能叠到 780。
  // 试过罚 340 —— 正好卡在 develop 那 360 上，靠 1 分之差决定领哪门，太脆；
  // 要罚得动就得罚到 800 上下，那已经等于硬规则，还会顺手压垮别的打法。
  //
  // 兜底同上：全手上下每张牌都会被读成求件时维持原判 —— 总得领一张出去，
  // 那种局面下这个信号是躲不掉的，真人也躲不掉。
  {
    const stray = [...proposals].filter(([, proposal]) =>
      straySignal(view, ctx, proposal.cards, tuning)
    );
    if (stray.length < proposals.size) {
      for (const [key] of stray) proposals.delete(key);
    }
  }

  // 【这门甩得出去，就别再一张一张领它】—— Glen 实战反馈第 4 条：
  //   「有时候 bot 求完件，我给它之后，它却不想甩，变成一张张打，浪费了机会。」
  //
  // 求件的全部目的就是把这门的件逼干净、好把这门整个甩出去。件都现完了还在
  // 同一门里一张一张领，等于把逼件的成果原地退回去：多给对手两墩认牌型的机会，
  // 等他断了这门就来毙。领【别的门】仍然自由 —— 我另有更要紧的安排是另一回事，
  // 那不算浪费；这里挡掉的只有「就是这门、却只领一张」。
  //
  // ⚠️ 实现成【让位】而不是【给甩牌加分】，这一点是量出来的：领同一门最小牌的
  // 那张卡片经常同时拿到 return-partner-suit(320~560) + develop-long-side-suit
  // (160~360) + low-card-fallback(20)，而 addProposal 对同一个 key 是【累加】的，
  // 轻松堆到 900 以上。60 局里 56 次「甩得出去却没甩」，22 次就是这三条叠出来的。
  // 要靠加分压住就得把甩牌抬到 1000 上下，那会连 cash-certain-control 一起盖掉。
  //
  // 计划性压住不甩的那一门（tailThrowPlan 挂起，等吊完主再甩）同样让位：
  // 那门本来就是留着整门甩的武器，一张一张漏出去正好把它拆了 —— 跟牌那边
  // 早就有「宁可垫低主也不拆长门」的护尾罚分，领牌这边不该反过来自己拆。
  //
  // 【护的是所有甩得出去的门，不只是 safeSideThrow 挑中的那一门】—— Glen 裁定：
  //   「一般来说，还是有一手甩牌对于对手来说会更有威胁，即使现在还是在吊主阶段，
  //     所以如果想一支支打，一般也不能打可以甩的门，这个非常浪费，因为如果吊主
  //     把对手手中的主的数量吊到低于你手中的甩牌数量的话，手上的那门甩牌就会
  //     非常有价值，甚至可以保底/撬底。」
  // 这条把「不拆」的理由从【顺手别浪费】改成了【那是留着的资产】：吊主阶段拆它
  // 恰恰拆掉了吊主的收益。所以判据用甩牌资格本身（canThrowByStatus + ≥2 张），
  // 不能用 safeSideThrow —— 那条回答的是「现在该甩哪一门」，还带早盘 ≥4 张的
  // 门槛，两张的门根本进不了它的候选，而实测浪费掉的 58 次里有 41 次正是两张门。
  //
  // ⚠️ 这里【不补甩牌提案】，只删单张领牌。Glen 说的是别拆，不是现在就甩；
  // 早盘那道 ≥4 张的门槛照旧管着「值不值得现在暴露」，两码事。
  const throwableSuits = SUITS.filter(suit =>
    suit !== ctx.trumpSuit &&
    cardsOfSuit(hand, suit, ctx).length >= 2 &&
    canThrowByStatus(view.round?.piecesView?.[suit])
  );
  // 注：safeSideThrow 选中的那一门必然在这个集合里（它的候选条件就是
  // 「≥2 张 && canThrowByStatus」再加筛选），所以不必单独并进来。
  if (throwableSuits.length > 0) {
    const throwSuits = new Set(throwableSuits);
    const victims = [...proposals].filter(([, proposal]) =>
      proposal.cards.length === 1 && throwSuits.has(suitOf(proposal.cards[0], ctx))
    );
    // 兜底：全删光了就没牌可领了（chooseLeadCards 会返回空数组）。
    // ⚠️ 扩到「所有甩得出去的门」之后这一行【真的会为假】——
    // 手上两门副牌都甩得出去、又一张主都没有时，单张提案会被删干净。
    // 那种局面下这条规矩本来就让不出位置：总得领一张，真人也一样。
    if (victims.length < proposals.size) {
      for (const [key] of victims) proposals.delete(key);
    }
  }

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

  // 能参与比大小的位置：满额跟花色、或满额主牌毙。挑大的才有意义。
  const selections = (cards, n) => {
    if (n < 0 || cards.length < n) return [];
    if (n === 0) return [[]];
    return uniqueCardSets([
      lowCards(cards, n, ctx),
      highCards(cards, n, ctx),
      pointCards(cards, n, ctx),
    ]);
  };

  // 垫牌位置：这一组【赢不下这一墩】。
  //
  // ⚠️ 混合花色的一手永远不参与比大小 —— server/trick.js 的 trickLeader 分支 A
  // 只认「满额跟花色」和「满额主牌毙」两种形状，凑张数的那几张连比都不比。
  // 所以在这些位置挑大的纯粹是白扔，一张也换不回来。
  //
  // Glen 实战②：我方甩一门牌，电脑把这门跟完，再拿【小鬼】去凑张数。
  // 根因不在牌值表而在候选形状 —— 赢不了的位置生成了 highCards：
  //   垫一张副 10 要按 candidatePoints * 14 罚 140，
  //   白扔一张小鬼只按 keepValue * 0.25 罚 40（早盘那条护鬼规则要求
  //   手牌 > 8 张，甩牌多发生在中后段，那时一分保护都没有）。
  // 于是「宁可扔鬼也不送 10 分」成了评分器的正解。这里直接不给它这个选项。
  const discards = (cards, n) => {
    if (n < 0 || cards.length < n) return [];
    if (n === 0) return [[]];
    // 「不动件」的那一手 —— 只有这一个候选时评分器无从选择。
    //
    // 副牌 A 的 cardStrength 是 14，低于任何主牌（900+），所以 lowCards 一旦
    // 挑到它，就说明手上除了件就只剩主牌（或更贵的副牌）了，那时它是【唯一】
    // 候选，亮件的代价罚多少都改不了结果。多给一手「宁可动主牌也不动件」，
    // 评分器才谈得上取舍。
    //
    // 常态下这一手会输 —— Glen：「A 的价值并不比小的主牌要高，本身它就比主牌
    // 要小」，keepValue 里副 A 是 59、最低的主花色是 78，正好是这个顺序。
    // 它是给两个例外准备的，见 pieceExposureRisk 上面那段。
    const cheapest = lowCards(cards, n, ctx);
    const sparing = cheapest.some(card => isSidePiece(card, ctx))
      ? lowCards(cards.filter(card => !isSidePiece(card, ctx)), n, ctx)
      : null;
    return uniqueCardSets([
      cheapest,
      pointCards(cards, n, ctx), // 队友已经赢下这一墩时把分送过去
      ...(sparing ? [sparing] : []),
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
  // 按牌力从小往大试，把【每一档够大的牌 + 最便宜的凑张数】都作为候选。
  //
  // ⚠️ 原来这里在第一组赢得下的地方就 return 了，理由是「那就是最省的一组」。
  // 但 trickLeader 只判【眼前这半墩】，后面还没出牌的人不算数 —— 于是电脑
  // 手上只剩两个极端：最小的那组（便宜，可后面两家能压过去）和 highCards
  //（安全，可要交两只鬼）。Glen 说的那个中间答案「一支大鬼还有一支小牌即可」
  // 从来没被生成过。
  // 实测 400 局里有 4 次因此一口气交出两只鬼，最贵的一次是
  //   手上 大鬼+小鬼+小鬼+H2+H14+H11+H10+H3，对手甩 ♦A♦K
  //   候选只有 [H3,H10] 和 [大鬼,小鬼]，而 [大鬼,H3] 才是对的。
  // 该出多大仍然由评分器按局面决定，这里只负责【把选项摆全】。
  const economical = pool => {
    if (pool.length < count) return [];
    const byStrength = [...pool].sort(
      (a, b) => cardStrength(a, ctx) - cardStrength(b, ctx) || a.id.localeCompare(b.id)
    );
    const out = [];
    for (const winner of byStrength) {
      const rest = pool.filter(card => card.id !== winner.id);
      const set = [winner, ...lowCards(rest, count - 1, ctx)];
      if (set.length !== count) continue;
      const led = trickLeader(
        [...view.round.currentTrick, { seat: view.you.seat, cards: set }],
        ctx
      );
      if (led?.seat === view.you.seat) out.push(set);
    }
    return out;
  };

  if (count === 1) {
    // 单张跟牌把所有合法牌都交给评分器，才能选出“刚好能赢”的那张。
    for (const card of hand) sets.push([card]);
  } else if (leadSuitCards.length >= count) {
    sets.push(...selections(leadSuitCards, count));
    sets.push(...economical(leadSuitCards));
  } else if (leadSuitCards.length > 0) {
    const rest = hand.filter(card => !leadSuitCards.includes(card));
    for (const fill of discards(rest, count - leadSuitCards.length)) {
      sets.push([...leadSuitCards, ...fill]);
    }
  } else {
    sets.push(...discards(hand, count));
    const trumps = cardsOfSuit(hand, 'TRUMP', ctx);
    sets.push(...selections(trumps, count));
    sets.push(...economical(trumps)); // 毙牌：一张够大的 + 最便宜的凑张数
    // 尽量把一门短牌整组垫完，为后续杀牌制造缺门。
    for (const suit of SUITS.filter(s => s !== ctx.trumpSuit)) {
      const group = cardsOfSuit(hand, suit, ctx);
      if (group.length === 0 || group.length > count) continue;
      const rest = hand.filter(card => !group.includes(card));
      for (const fill of discards(rest, count - group.length)) sets.push([...group, ...fill]);
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
  //
  // ⚠️ 这条代价原来挂在 early（手牌 > 8 张）上，等于【后半盘完全不管】。方向反了：
  // 保底/撬底比的就是最后一墩，越往后这张鬼越金贵。Glen 第三次提这件事：
  //   「留鬼保底/撬底是潮汕升级的基本打法，不能见牌或见分就砍……有保底/撬底的
  //     鬼组合（如大小鬼）还是见牌就砍，需要再严格地出这个规则。」
  // 实测 200 局（scripts/audit/joker-hoard.mjs）：躲得掉却还是砍掉的鬼 359 张，
  // 其中 333 张（93%）在手牌 ≤8 张那半盘 —— 正是这条代价失效的地方。
  // 插桩再往里看一层：那些局面里【保底判定本身拦不住】—— 一半是「打完还保得住」
  // （交一张还剩一张），四分之一是「打之前就已经保不住」。拦不住是对的，
  // 因为丢的不是底，是【为了一墩零分的牌把保底/撬底的本钱花掉了】，
  // 那笔账只有这条「够不够分」的代价算得清。
  //
  // 尾盘该兑现的时候不会被卡死：手上只剩鬼时评分器根本没有别的候选；
  // 而最后两墩另有一条 remaining.length <= lead.cards.length 的加分顶着。
  const jokersSpent = cards.filter(card => card.rank === 15 || card.rank === 16);
  if (jokersSpent.length > 0) {
    const cost = jokersSpent.reduce((sum, card) => sum + keepValue(card, ctx), 0);
    // 2.2 这个系数是扫出来的，不是拍的：只用 cost 本身时抢牌权的加分仍然压得过它，
    // 桌上 5 分就肯把小鬼扔出去；1.6 还剩 2 次；2.2 归零；3.0 没有更好 —— 拐点在 2.2。
    // 效果大致是「20 分以上才划算」，跟真人的直觉一致：开局那 5 分不值一张鬼。
    // 也确认过没有矫枉过正：领鬼次数 13 → 12，仍然都发生在第 3 轮之后。
    score -= Math.max(0, cost * 2.2 - totalPoints * 8) * settings.controlReserve * controlCaution;
  }

  // 第三手封分：前两手都不大时，若最后的对手仍可能用 10/K 等分牌反超，
  // 提高当前牌面上限；公开记录已证明对手缺门或分牌均已现时风险自然归零。
  //
  // ⚠️ 但「封分」和「亮件」是两笔账，谁让路由 Glen 裁定（「第三家 10 分要不要
  // 打 A 封」的第 2 种情况）：
  //   「如果此门副牌不长，但也不短，大概 5 张，没有出过件的情况，最好也是不杀，
  //     风险一样……如果判断件有可能在自己对家，然后自己还有大牌，比如 Q 或是 J 多，
  //     可以逼别人的件出来的情况，特别是别人可能只剩一件，逼出来之后，
  //     别人的甩牌自己可能可以大，也可以杀。」
  // 这门【一支件都还没现过】时，亮出第一支就是把这门的甩牌资格从零推起来，
  // 比桌上那 10 分重得多 —— 所以「封住最后一家」这个理由对这种候选不成立。
  // 例外就是他给的那条：件可能在对家（对家在这门求过牌），而且逼出来之后
  // 这门的顶端还在我手上（forcesPiecesOut）—— 那时候件是逼出来给自己用的。
  //
  // 代码里原来留着一条注释说这一档「还没有裁定，没裁定的事不写成断言」，现在裁定了。
  //
  // ⚠️ 这条【不是挂在候选上，是挂在整墩上】。第一版写成「含件的候选不吃封分加成」，
  // 一点用没有 —— 那 161 分的差距来自【垫小牌那个候选被罚】，不是打 ♠A 被奖。
  // 要表达「这一墩不必封」，就得让整墩的封分账归零，垫小牌的那些候选才不挨罚。
  score -= (coverNeedsFirstPiece(view, ctx) ? 0 : lastSeatPointRisk) *
    24 * settings.inference * coverCaution * tuning.coverRiskWeight;

  // 还有后家时只是“暂时领先”，不能把桌面分当成已经收下。
  if (afterTeamWinning) score += 40 + totalPoints * (lastToAct ? 5 : 1);
  else score -= 30 + totalPoints * 8;

  // 分牌暴露是独立风险：后面还有人未出时，K/10/5 不能因“暂时领先”反而加分。
  //
  // ⚠️ 第三种「公开信息已排除反超」的情形：我这一手是满额主牌（毙牌或跟主），
  // 而且外面没有任何一张更大的主牌还没现身 —— 这一墩已经落袋，带上去的分
  // 一点风险都没有。原来只写了 publiclySafeThirdFeed / guaranteedPartnerControl
  // 两个很窄的情形，毙牌完全不在里面，结果是：
  //   带一张主 10 去毙 → 罚 candidatePoints × 12 = 120
  //   多交一只小鬼去毙 → 只罚 keepValue × 0.25 = 40
  // 于是电脑宁可多花一只鬼，也不肯把自己那张带分的主牌打出去。
  // Glen 实战反馈③「鬼还是有乱出的情况」里剩下的那几例全是这个形状。
  const unbeatableTake =
    playersBehind > 0 && candidatePoints > 0 &&
    after?.seat === you.seat && unbeatableTrumpPlay(view, ctx, cards);
  if (playersBehind > 0 && candidatePoints > 0) {
    if (publiclySafeThirdFeed || guaranteedPartnerControl || unbeatableTake) {
      // 只有公开信息已排除反超时，才可以放心把分带上去 / 送给朋友。
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
    lead.seat === partnerSeatOf(you.seat) &&
    isPieceRequestLead(lead.cards, ctx) &&
    // 我方在这门已经求过一次了 —— 这一张小牌不是新的求件（Glen）
    !teamAskedPieceBefore(view, ctx, lead.playSuit, you.team);
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
  // ⚠️ 这里改了口径：原来只要【队友最近领过这门】就整条豁免，不管他领的是
  // 什么牌。可 Glen 的原话是「如果对家【有表示】，那是可以很没压力地出件的」，
  // 表示 = 求件（领 5 以下的小牌），领一张 A 不是表示。
  // 旧口径还有一个直接后果：他贡献完件、随手回一张小牌，也照样把豁免续上，
  // 于是上面那条「只认第一次」被架空 —— 两处必须一起改才管用。
  const request = partnerProbe
    ? { suit: lead.playSuit, seeking: true }
    : partnerRequest(view, ctx);
  const partnerAskedSuit = request?.seeking ? request.suit : null;
  const exposureRisk = pieceExposureRisk(view, ctx, cards, partnerAskedSuit, tuning);
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
  //   1. 这一下之后就握不住顶端了 —— 双大鬼一起交出去，外面那张小鬼就成了场上最大的
  //   2. 这一墩的分【到不了移庄线】—— 到得了就无所谓底了，该砍就砍
  //
  // ⚠️ 必须排在 economical 候选之后才有意义：能用「一鬼 + 一张小主」毙下来时
  // 顶端根本没丢，条件 1 就不成立 —— 先挑最省的打法，省不下来了才谈放不放。
  //
  // ⚠️ 这里原来还有第三个条件 isKill（副牌墩、我缺门、整手主牌毙）。去掉了，
  // 因为它把最常见的那个场面漏在外面：isKill 要求 lead.playSuit !== 'TRUMP'，
  // 而【首家领主牌时 isKill 恒为 false】—— 别人吊主、我拿鬼去压，一分代价没有。
  // Glen 第三次提这件事：「有保底/撬底的鬼组合（如大小鬼）还是见牌就砍，
  // 需要再严格地出这个规则。」实测 200 局：躲得掉却还是砍掉的鬼 359 张，
  // 其中 333 张（93%）在手牌 ≤8 张的后半盘，最大的一格是「这一墩一分没有」209 张。
  //
  // 丢掉的是【同一件资产】，跟这一墩是副牌还是主牌无关：assessBottomControl 数的
  // 是「我这一档及以上的张数 vs 别人能压我的张数」，大小鬼在手正是让这个比较
  // 成立的组合，交掉一张就翻过去了。
  const afterDefenderPoints = (round.defenderTrickPoints ?? 0) + totalPoints;
  if (
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

  // 对手在求的那门，件让位（判据和理由见 pieceOwedToOpponentAsk）。
  //
  // 兜底：全部候选都得交件时维持原判 —— 那就是躲不掉，真人也躲不掉。
  // ⚠️ 变异测试杀不掉这一行（mutants27），因为【推得出它永远为真】：
  // 「欠着」要求这门打完还剩 >2 张，而我在这门最多只有 1 支件（≥2 支就豁免了），
  // 所以那门至少还有 3 张非件牌 —— 跟牌时它们各自成候选，垫牌时同样进得了
  // discards。留着的理由和领牌那边一样：真塌了的代价是电脑返回空手
  //（真人正在打的局里直接卡死），而代价只是一次比较。
  const sparing = choices.filter(choice => !pieceOwedToOpponentAsk(view, ctx, choice.cards));
  const pool = sparing.length > 0 ? sparing : choices;

  return pool
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
