import { applyAction } from './actions.js';
import { pathToFileURL } from 'node:url';
import { inferPublicBeliefs } from './bot-belief.js';
import { botLearningProfile, BotReviewJournal } from './bot-review.js';
import { assessBottomProtection, decideBotAction, normalizeBotDifficulty } from './bot-policy.js';
import { evolvedBotTuning } from './bot-tuning.js';
import { cardPoints, cardStrength, playSuitOf } from './cards.js';
import { GameEngine } from './game-engine.js';
import { mulberry32 } from './rng.js';
import { createInitialState, normalizeBotLearning } from './state.js';
import { trickLeader } from './trick.js';
import { viewerState } from './viewer.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function integerArg(name, fallback) {
  const prefix = `--${name}=`;
  const raw = process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length);
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function stringArg(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find(value => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function aggregateCounts(target, source = {}) {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + (Number(value) || 0);
  }
}

function removePlayed(remaining, plays) {
  for (const play of plays) {
    const ids = new Set(play.cards.map(card => card.id));
    remaining.set(
      play.seat,
      (remaining.get(play.seat) ?? []).filter(card => !ids.has(card.id))
    );
  }
}

function isSidePiece(card, ctx) {
  return (
    card.suit !== 'JOKER' &&
    card.suit !== ctx.trumpSuit &&
    (card.rank === 13 || card.rank === 14) &&
    card.rank !== ctx.rankCard
  );
}

// 局后分析只用于评价策略，不参与当时的电脑决策。
// 初始“剩余手牌”由最终未打出的牌 + 本局实际出过的牌重建，因此也兼容碾压提前结束。
function analyzeThirdSeatA(state) {
  const round = state.round;
  const ctx = { trumpSuit: round.trumpSuit, rankCard: round.rankCard };
  const history = round.trickHistory ?? [];
  const remaining = new Map(
    state.players.map(player => [
      player.seat,
      [
        ...player.hand,
        ...history.flatMap(trick =>
          (trick.plays ?? [])
            .filter(play => play.seat === player.seat)
            .flatMap(play => play.cards)
        ),
      ],
    ])
  );
  const stats = {
    trumpAceOpportunities: 0,
    trumpAcePlayed: 0,
    trumpAceWon: 0,
    fourthSpentHigherControl: 0,
    fourthHigherControlForced: 0,
    fourthHigherControlOptional: 0,
    sideAcePlayedOnEmptyThirdSeat: 0,
    sideAceOnlyPieces: 0,
    sideAceWithNonPieceAlternative: 0,
    sideAceHelpedPartnerWithPieces: 0,
    sideAceNeitherForcedNorPartnerPieces: 0,
    partnerPieceAskOpportunities: 0,
    partnerPieceContributed: 0,
    partnerPointAskAceOpportunities: 0,
    partnerPointAskAcePlayed: 0,
    partnerCoverOpportunities: 0,
    partnerCoverSucceeded: 0,
    partnerPieceContinuationOpportunities: 0,
    partnerPieceContinued: 0,
  };

  for (let trickIndex = 0; trickIndex < history.length; trickIndex += 1) {
    const trick = history[trickIndex];
    const plays = trick.plays ?? [];
    if (plays.length === 4 && plays.every(play => play.cards.length === 1)) {
      const firstTwo = plays.slice(0, 2).map(play => play.cards[0]);
      const third = plays[2];
      const fourth = plays[3];
      const noPointsBeforeThird = firstTwo.every(card => cardPoints(card) === 0);

      if (trick.leadSuit !== 'TRUMP') {
        const leadCard = plays[0].cards[0];
        const thirdHand = remaining.get(third.seat) ?? [];
        const thirdSuitCards = thirdHand.filter(
          card => playSuitOf(card, ctx.trumpSuit, ctx.rankCard) === trick.leadSuit
        );
        const thirdPieces = thirdSuitCards.filter(card => isSidePiece(card, ctx));
        const leadAsksForPiece = cardPoints(leadCard) > 0 || !isSidePiece(leadCard, ctx);
        if (leadAsksForPiece && thirdPieces.length > 0) {
          stats.partnerPieceAskOpportunities += 1;
          if (isSidePiece(third.cards[0], ctx)) stats.partnerPieceContributed += 1;
          const contributed = isSidePiece(third.cards[0], ctx);
          const playedIds = new Set(third.cards.map(card => card.id));
          const remainingPieces = thirdPieces.filter(card => !playedIds.has(card.id));
          const nextTrick = history[trickIndex + 1];
          if (
            contributed &&
            trick.winnerSeat === third.seat &&
            remainingPieces.length > 0 &&
            nextTrick?.leadSeat === third.seat
          ) {
            stats.partnerPieceContinuationOpportunities += 1;
            const nextLead = nextTrick.plays?.[0];
            if (
              nextLead?.playSuit === trick.leadSuit &&
              nextLead.cards.some(card => isSidePiece(card, ctx))
            ) {
              stats.partnerPieceContinued += 1;
            }
          }
        }
        const thirdAces = thirdSuitCards.filter(card => card.rank === 14 && isSidePiece(card, ctx));
        if (cardPoints(leadCard) > 0 && thirdAces.length > 0) {
          stats.partnerPointAskAceOpportunities += 1;
          if (third.cards[0].rank === 14 && isSidePiece(third.cards[0], ctx)) {
            stats.partnerPointAskAcePlayed += 1;
          }
        }
        if (leadAsksForPiece && thirdPieces.length === 0) {
          const beforeThird = trickLeader(plays.slice(0, 2), ctx);
          const possibleCover = thirdSuitCards.some(card =>
            cardPoints(card) === 0 &&
            trickLeader([...plays.slice(0, 2), { seat: third.seat, cards: [card] }], ctx)?.seat === third.seat
          );
          if (beforeThird?.seat % 2 !== third.seat % 2 && possibleCover) {
            stats.partnerCoverOpportunities += 1;
            if (trickLeader(plays.slice(0, 3), ctx)?.seat === third.seat) {
              stats.partnerCoverSucceeded += 1;
            }
          }
        }
      }

      if (trick.leadSuit === 'TRUMP' && round.rankCard !== 14 && noPointsBeforeThird) {
        const mainTrumpAce = { suit: round.trumpSuit, rank: 14 };
        const aceStrength = cardStrength(mainTrumpAce, ctx);
        const firstTwoAreSmall = firstTwo.every(card => cardStrength(card, ctx) < aceStrength);
        const heldMainTrumpAce = (remaining.get(third.seat) ?? []).some(
          card => card.suit === round.trumpSuit && card.rank === 14
        );
        if (firstTwoAreSmall && heldMainTrumpAce) {
          stats.trumpAceOpportunities += 1;
          const playedMainTrumpAce = third.cards[0].suit === round.trumpSuit && third.cards[0].rank === 14;
          if (playedMainTrumpAce) {
            stats.trumpAcePlayed += 1;
            if (trick.winnerSeat === third.seat) stats.trumpAceWon += 1;
            if (cardStrength(fourth.cards[0], ctx) > aceStrength) {
              stats.fourthSpentHigherControl += 1;
              const fourthSafeLowTrumps = (remaining.get(fourth.seat) ?? []).filter(
                card =>
                  playSuitOf(card, ctx.trumpSuit, ctx.rankCard) === 'TRUMP' &&
                  cardStrength(card, ctx) <= aceStrength &&
                  cardPoints(card) === 0
              );
              if (fourthSafeLowTrumps.length > 0) stats.fourthHigherControlOptional += 1;
              else stats.fourthHigherControlForced += 1;
            }
          }
        }
      }

      if (trick.leadSuit !== 'TRUMP' && noPointsBeforeThird) {
        const heldSideAce = (remaining.get(third.seat) ?? []).some(
          card =>
            card.suit === trick.leadSuit &&
            card.rank === 14 &&
            playSuitOf(card, ctx.trumpSuit, ctx.rankCard) === trick.leadSuit
        );
        const playedSideAce = third.cards[0].suit === trick.leadSuit && third.cards[0].rank === 14;
        if (heldSideAce && playedSideAce) {
          stats.sideAcePlayedOnEmptyThirdSeat += 1;
          const thirdSuitCards = (remaining.get(third.seat) ?? []).filter(
            card => playSuitOf(card, ctx.trumpSuit, ctx.rankCard) === trick.leadSuit
          );
          const thirdOnlyHasPieces = thirdSuitCards.every(card => card.rank === 13 || card.rank === 14);
          if (thirdOnlyHasPieces) stats.sideAceOnlyPieces += 1;
          else stats.sideAceWithNonPieceAlternative += 1;

          const partnerPieces = (remaining.get(plays[0].seat) ?? []).filter(
            card =>
              playSuitOf(card, ctx.trumpSuit, ctx.rankCard) === trick.leadSuit &&
              (card.rank === 13 || card.rank === 14)
          );
          if (partnerPieces.length > 0) stats.sideAceHelpedPartnerWithPieces += 1;
          if (!thirdOnlyHasPieces && partnerPieces.length === 0) {
            stats.sideAceNeitherForcedNorPartnerPieces += 1;
          }
        }
      }
    }
    removePlayed(remaining, plays);
  }
  return stats;
}

export async function simulateRound({
  seed,
  difficulty = 'expert',
  inheritedLearning = normalizeBotLearning(),
  timeoutMs = 15_000,
  fixedDeclarerSeat = null,
  declarationMode = 'patient',
  tuning = evolvedBotTuning(),
  tuningByTeam = null,
}) {
  const state = createInitialState(mulberry32(seed));
  state.seed = seed;
  state.niiRandom = () => 1;
  state.botLearning = normalizeBotLearning(clone(inheritedLearning));
  state.declarerSeat = fixedDeclarerSeat;
  for (const player of state.players) {
    const joined = applyAction(state, { type: 'join' }, player.id);
    if (!joined.ok) throw new Error(`种子 ${seed}：${player.id} 加入失败：${joined.error?.reason}`);
    player.isBot = true;
  }

  const engine = new GameEngine({
    state,
    timings: {
      flipMs: 1,
      drawMs: 10,
      graceMs: 1,
      fallbackMs: 1,
      dealingMs: 1,
      settleMs: 1,
      finalSettleMs: 1,
      finalHoldMs: 1,
      scoringMs: 1,
      roundEndMs: 1,
      playMs: 100,
      crossRiverDecideMs: 1,
      crossRiverPickMs: 10,
      autoLastMs: 1,
    },
  });
  const journal = new BotReviewJournal();
  const errors = [];
  let declaration = null;
  let kittyPlan = null;
  const deadline = Date.now() + timeoutMs;

  while (state.rounds.length === 0 && Date.now() < deadline && errors.length === 0) {
    let acted = false;
    for (const player of [...state.players].sort((a, b) => a.seat - b.seat)) {
      const publicView = viewerState(state, player.id);
      const view = publicView
        ? {
          ...publicView,
          botDifficulty: difficulty,
          botDeclarationMode: declarationMode,
          botProfile: botLearningProfile(state, player.id),
          botTuning: tuningByTeam?.[player.team] ?? tuning,
        }
        : null;
      if (view) view.botBeliefs = inferPublicBeliefs(view);
      const action = decideBotAction(view);
      if (!action) continue;
      const reviewRecord = journal.record(view, action);
      if (action.type === 'declareTrump') {
        const declared = view.you.hand.find(card => card.id === action.cardId);
        const ctx = { trumpSuit: declared?.suit, rankCard: view.round.rankCard };
        declaration = {
          seat: player.seat,
          drawnCount: view.round.drawnCount,
          handSize: view.you.hand.length,
          suit: declared?.suit ?? null,
          ordinarySuitCount: view.you.hand.filter(
            card => card.suit === declared?.suit && card.rank !== view.round.rankCard
          ).length,
          resultingTrumpCount: view.you.hand.filter(
            card => playSuitOf(card, ctx.trumpSuit, ctx.rankCard) === 'TRUMP'
          ).length,
        };
      }
      if (action.type === 'buryKitty') {
        const ids = new Set(action.cardIds ?? []);
        const buried = view.you.hand.filter(card => ids.has(card.id));
        const structuredPieceIds = new Set();
        const pairedPieceIds = new Set();
        const longSuitPieceIds = new Set();
        for (const suit of ['S', 'H', 'D', 'C'].filter(item => item !== view.round.trumpSuit)) {
          const group = view.you.hand.filter(card =>
            playSuitOf(card, view.round.trumpSuit, view.round.rankCard) === suit
          );
          const aces = group.filter(card => card.rank === 14);
          const kings = group.filter(card => card.rank === 13);
          const pieces = [...aces, ...kings];
          if (aces.length >= 2 || kings.length >= 2 || pieces.length >= 3) {
            for (const piece of pieces) pairedPieceIds.add(piece.id);
          }
          if (group.length >= 5) {
            for (const piece of pieces) longSuitPieceIds.add(piece.id);
          }
          for (const id of [...pairedPieceIds, ...longSuitPieceIds]) structuredPieceIds.add(id);
        }
        const protection = assessBottomProtection(view.you.hand, {
          trumpSuit: view.round.trumpSuit,
          rankCard: view.round.rankCard,
        });
        kittyPlan = {
          bottomConfidence: Number(protection.confidence.toFixed(3)),
          trumpCount: protection.trumpCount,
          bigJokers: protection.bigJokers,
          buriedPoints: buried.reduce((sum, card) => sum + cardPoints(card), 0),
          buriedKings: buried.filter(card => card.rank === 13).length,
          buriedStructuredPieces: buried.filter(card => structuredPieceIds.has(card.id)).length,
          buriedPairedPieces: buried.filter(card => pairedPieceIds.has(card.id)).length,
          buriedLongSuitPieces: buried.filter(card => longSuitPieceIds.has(card.id)).length,
          buriedTrumps: buried.filter(
            card => playSuitOf(card, view.round.trumpSuit, view.round.rankCard) === 'TRUMP'
          ).length,
        };
      }
      const result = engine.applyAction({ ...action, phase: view.phase }, player.id);
      if (!result.ok) {
        journal.discard(reviewRecord);
        errors.push({ playerId: player.id, reason: result.error?.reason ?? '未知错误' });
      } else {
        journal.finalizeCompletedRounds(state);
      }
      acted = true;
      break;
    }
    if (!acted) await sleep(1);
  }

  engine.clearTimers();
  if (state.rounds.length === 0) errors.push({ playerId: null, reason: '模拟超时，未完成一局' });
  const summary = state.rounds[0] ?? null;
  return {
    state,
    summary,
    errors,
    thirdSeatA: summary ? analyzeThirdSeatA(state) : {},
    declaration,
    kittyPlan,
  };
}

export async function main() {
  const games = integerArg('games', 20);
  const baseSeed = integerArg('seed', 2026081701);
  const timeoutMs = integerArg('timeout', 15_000);
  const difficulty = normalizeBotDifficulty(stringArg('difficulty', 'expert'));
  const includeRoundDetails = stringArg('details', 'false') === 'true';
  const roundMode = stringArg('round-mode', 'first');
  const declarationMode = stringArg('declare-mode', 'patient');
  let learning = normalizeBotLearning();
  const aggregate = {
    games,
    difficulty,
    roundMode,
    declarationMode,
    seeds: [],
    completed: 0,
    conservationOk: 0,
    dealerBottomSaved: 0,
    defenderKittyGrabs: 0,
    dealerRoundsWon: 0,
    defenderRoundsWon: 0,
    defenderPointsTotal: 0,
    kittyPointsTotal: 0,
    kittyPlans: {
      highConfidenceCount: 0,
      highConfidenceBuriedPointsTotal: 0,
      lowerConfidenceCount: 0,
      lowerConfidenceBuriedPointsTotal: 0,
      buriedKingsTotal: 0,
      buriedStructuredPiecesTotal: 0,
      buriedPairedPiecesTotal: 0,
      buriedLongSuitPiecesTotal: 0,
      buriedTrumpsTotal: 0,
    },
    errors: [],
    reviewCounts: {},
    thirdSeatA: {},
    declarations: {
      count: 0,
      drawnCountTotal: 0,
      ordinarySuitCountTotal: 0,
      resultingTrumpCountTotal: 0,
    },
    rounds: [],
  };

  for (let index = 0; index < games; index += 1) {
    const seed = (baseSeed + index * 9973) >>> 0;
    aggregate.seeds.push(seed);
    const fixedDeclarerSeat = roundMode === 'later'
      ? index % 4
      : roundMode === 'mixed' && index % 2 === 1
        ? index % 4
        : null;
    const result = await simulateRound({
      seed,
      difficulty,
      inheritedLearning: learning,
      timeoutMs,
      fixedDeclarerSeat,
      declarationMode,
    });
    if (result.errors.length > 0 || !result.summary) {
      aggregate.errors.push(...result.errors.map(error => ({ seed, ...error })));
      continue;
    }

    const summary = result.summary;
    learning = clone(result.state.botLearning);
    aggregate.completed += 1;
    if (summary.conservationOk) aggregate.conservationOk += 1;
    if (summary.kittyGrab) aggregate.defenderKittyGrabs += 1;
    else aggregate.dealerBottomSaved += 1;
    if (summary.transfer) aggregate.defenderRoundsWon += 1;
    else aggregate.dealerRoundsWon += 1;
    aggregate.defenderPointsTotal += summary.defenderPoints;
    aggregate.kittyPointsTotal += summary.kittyPoints;
    if ((result.kittyPlan?.bottomConfidence ?? 0) >= 0.72) {
      aggregate.kittyPlans.highConfidenceCount += 1;
      aggregate.kittyPlans.highConfidenceBuriedPointsTotal += result.kittyPlan.buriedPoints;
    } else if (result.kittyPlan) {
      aggregate.kittyPlans.lowerConfidenceCount += 1;
      aggregate.kittyPlans.lowerConfidenceBuriedPointsTotal += result.kittyPlan.buriedPoints;
    }
    if (result.kittyPlan) {
      aggregate.kittyPlans.buriedKingsTotal += result.kittyPlan.buriedKings;
      aggregate.kittyPlans.buriedStructuredPiecesTotal += result.kittyPlan.buriedStructuredPieces;
      aggregate.kittyPlans.buriedPairedPiecesTotal += result.kittyPlan.buriedPairedPieces;
      aggregate.kittyPlans.buriedLongSuitPiecesTotal += result.kittyPlan.buriedLongSuitPieces;
      aggregate.kittyPlans.buriedTrumpsTotal += result.kittyPlan.buriedTrumps;
    }
    aggregateCounts(aggregate.reviewCounts, summary.botReview?.counts);
    aggregateCounts(aggregate.thirdSeatA, result.thirdSeatA);
    if (result.declaration) {
      aggregate.declarations.count += 1;
      aggregate.declarations.drawnCountTotal += result.declaration.drawnCount;
      aggregate.declarations.ordinarySuitCountTotal += result.declaration.ordinarySuitCount;
      aggregate.declarations.resultingTrumpCountTotal += result.declaration.resultingTrumpCount;
    }
    aggregate.rounds.push({
      game: index + 1,
      seed,
      declarerSeat: summary.declarerSeat,
      trumpSuit: summary.trumpSuit,
      rankCard: summary.rankCard,
      defenderPoints: summary.defenderPoints,
      kittyGrab: summary.kittyGrab,
      transfer: summary.transfer,
      reviewIssues: summary.botReview?.issueCount ?? 0,
      thirdSeatA: result.thirdSeatA,
      declaration: result.declaration,
      kittyPlan: result.kittyPlan,
    });
  }

  aggregate.averageDefenderPoints = aggregate.completed > 0
    ? Number((aggregate.defenderPointsTotal / aggregate.completed).toFixed(1))
    : null;
  aggregate.averageKittyPoints = aggregate.completed > 0
    ? Number((aggregate.kittyPointsTotal / aggregate.completed).toFixed(1))
    : null;
  aggregate.kittyPlans.averageHighConfidenceBuriedPoints = aggregate.kittyPlans.highConfidenceCount > 0
    ? Number((aggregate.kittyPlans.highConfidenceBuriedPointsTotal / aggregate.kittyPlans.highConfidenceCount).toFixed(1))
    : null;
  aggregate.kittyPlans.averageLowerConfidenceBuriedPoints = aggregate.kittyPlans.lowerConfidenceCount > 0
    ? Number((aggregate.kittyPlans.lowerConfidenceBuriedPointsTotal / aggregate.kittyPlans.lowerConfidenceCount).toFixed(1))
    : null;
  aggregate.declarations.averageDrawnCount = aggregate.declarations.count > 0
    ? Number((aggregate.declarations.drawnCountTotal / aggregate.declarations.count).toFixed(1))
    : null;
  aggregate.declarations.averageOrdinarySuitCount = aggregate.declarations.count > 0
    ? Number((aggregate.declarations.ordinarySuitCountTotal / aggregate.declarations.count).toFixed(1))
    : null;
  aggregate.declarations.averageResultingTrumpCount = aggregate.declarations.count > 0
    ? Number((aggregate.declarations.resultingTrumpCountTotal / aggregate.declarations.count).toFixed(1))
    : null;
  aggregate.learning = learning.shared;
  if (!includeRoundDetails) delete aggregate.rounds;
  console.log(JSON.stringify(aggregate, null, 2));
  if (aggregate.completed !== games || aggregate.errors.length > 0) process.exitCode = 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
