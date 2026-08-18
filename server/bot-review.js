import { cardLabel, cardStrength, playSuitOf } from './cards.js';
import { evaluateFollowChoices } from './bot-policy.js';
import { normalizeBotLearning } from './state.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function cardSetKey(cards) {
  return cards.map(card => card.id).sort().join('|');
}

function isSidePiece(card, ctx) {
  return (
    card.suit !== 'JOKER' &&
    card.suit !== ctx.trumpSuit &&
    (card.rank === 13 || card.rank === 14) &&
    card.rank !== ctx.rankCard
  );
}

function labels(cards) {
  return cards.map(cardLabel).join('、');
}

function learningFor(state) {
  state.botLearning = normalizeBotLearning(state.botLearning);
  return state.botLearning;
}

function profileFor(learning, playerId) {
  learning.players[playerId] ??= {
    reviewedPlays: 0,
    pieceCaution: 1,
    pointCaution: 1,
    overplayCaution: 1,
    coverCaution: 1,
    controlCaution: 1,
  };
  return learning.players[playerId];
}

function blendedCaution(sharedValue, playerValue) {
  // 共享经验全量生效；个人经验只作为轻量个性化，避免同一错误被重复放大。
  return clamp(sharedValue + (playerValue - 1) * 0.35, 1, 3);
}

// BotController 只把这些数字注入当前电脑自己的 viewerState。
// 新电脑也会立即继承其他电脑已经学到的共享经验。
export function botLearningProfile(state, playerId) {
  const learning = learningFor(state);
  const own = profileFor(learning, playerId);
  const shared = learning.shared;
  return {
    reviewedPlays: own.reviewedPlays,
    sharedRoundsReviewed: shared.roundsReviewed,
    pieceCaution: blendedCaution(shared.pieceCaution, own.pieceCaution),
    pointCaution: blendedCaution(shared.pointCaution, own.pointCaution),
    overplayCaution: blendedCaution(shared.overplayCaution, own.overplayCaution),
    coverCaution: blendedCaution(shared.coverCaution, own.coverCaution),
    controlCaution: blendedCaution(shared.controlCaution, own.controlCaution),
    dealerBottomWeight: shared.dealerBottomWeight,
    defenderBottomWeight: shared.defenderBottomWeight,
  };
}

function updateBottomLearning(shared, summary, representedTeams) {
  const declarerTeam = summary.declarerSeat % 2;
  if (representedTeams.has(declarerTeam)) {
    shared.dealerRounds += 1;
    if (summary.kittyGrab) {
      shared.dealerBottomWeight = clamp(shared.dealerBottomWeight + 0.06, 1, 2.5);
    } else {
      shared.dealerBottomSaved += 1;
      shared.dealerBottomWeight = clamp(shared.dealerBottomWeight - 0.01, 1, 2.5);
    }
  }
  if (representedTeams.has(1 - declarerTeam)) {
    shared.defenderRounds += 1;
    if (summary.kittyGrab) {
      shared.defenderBottomGrabbed += 1;
      shared.defenderBottomWeight = clamp(shared.defenderBottomWeight - 0.01, 1, 2.5);
    } else {
      shared.defenderBottomWeight = clamp(shared.defenderBottomWeight + 0.06, 1, 2.5);
    }
  }
}

function learningSnapshot(shared) {
  return {
    roundsReviewed: shared.roundsReviewed,
    playsReviewed: shared.playsReviewed,
    dealerBottomWeight: shared.dealerBottomWeight,
    defenderBottomWeight: shared.defenderBottomWeight,
    dealerRounds: shared.dealerRounds,
    dealerBottomSaved: shared.dealerBottomSaved,
    dealerBottomRate: shared.dealerRounds > 0
      ? shared.dealerBottomSaved / shared.dealerRounds
      : null,
    defenderRounds: shared.defenderRounds,
    defenderBottomGrabbed: shared.defenderBottomGrabbed,
    defenderBottomRate: shared.defenderRounds > 0
      ? shared.defenderBottomGrabbed / shared.defenderRounds
      : null,
  };
}

function betterAlternative(choices, chosen, predicate) {
  return choices
    .filter(choice => choice.provisionalLeaderSeat === chosen.provisionalLeaderSeat)
    .filter(predicate)
    .sort(
      (a, b) =>
        a.pieceCount - b.pieceCount ||
        a.pointValue - b.pointValue ||
        a.preserveCost - b.preserveCost
    )[0] ?? null;
}

// 封存出牌当时的公开视角，并用当时的合法候选做“同结果更低代价”检查。
// 这里完全不接收服务端其他玩家的手牌。
export function inspectBotPlay(view, action) {
  const round = view.round;
  const chosenCards = action.cardIds
    .map(id => view.you.hand.find(card => card.id === id))
    .filter(Boolean);
  const record = {
    playerId: view.you.id,
    nickname: view.you.nickname,
    seat: view.you.seat,
    team: view.you.team,
    roundNumber: round.roundNumber,
    trickNo: (round.trickHistory?.length ?? 0) + 1,
    chosenLabels: labels(chosenCards),
    issues: [],
  };
  if (round.currentTrick.length === 0 || chosenCards.length === 0) return record;

  const ctx = { trumpSuit: round.trumpSuit, rankCard: round.rankCard };
  const choices = evaluateFollowChoices(view);
  const chosen = choices.find(choice => cardSetKey(choice.cards) === cardSetKey(chosenCards));
  if (!chosen) return record;

  const lead = round.currentTrick[0];
  const playersBehind = 3 - round.currentTrick.length;
  const partnerSideProtocol =
    round.currentTrick.length === 2 &&
    lead.seat === (view.you.seat + 2) % 4 &&
    lead.playSuit !== 'TRUMP' &&
    lead.cards.length === 1;
  const opponentProbe =
    lead.seat % 2 !== view.you.team &&
    lead.playSuit !== 'TRUMP' &&
    lead.cards.every(card => !isSidePiece(card, ctx));
  const donatedPieces = chosenCards.filter(
    card => playSuitOf(card, ctx.trumpSuit, ctx.rankCard) === lead.playSuit && isSidePiece(card, ctx)
  );
  const unseenPieces = (round.piecesView?.[lead.playSuit] ?? [])
    .filter(item => item.status === 'unseen').length;

  const openingAsk =
    (round.trickHistory?.length ?? 0) === 0 &&
    lead.seat === view.declarerSeat &&
    lead.playSuit === 'TRUMP' &&
    lead.cards.length === 1 &&
    lead.cards.every(card => card.rank !== 16) &&
    view.you.seat === (view.declarerSeat + 2) % 4;
  const trumpAceStrength = ctx.rankCard === 14
    ? 997
    : cardStrength({ id: 'signal-threshold', suit: ctx.trumpSuit, rank: 14 }, ctx);
  const openingNonJokerChoices = openingAsk
    ? choices.filter(choice =>
      choice.cards.every(card =>
        playSuitOf(card, ctx.trumpSuit, ctx.rankCard) === 'TRUMP' && card.rank < 15
      )
    )
    : [];
  const openingSignalChoices = openingNonJokerChoices.filter(choice =>
    choice.cards.every(card => cardStrength(card, ctx) >= trumpAceStrength)
  );
  const openingTakeoverChoices = openingSignalChoices.filter(choice =>
    choice.provisionalLeaderSeat === view.you.seat
  );
  const chosenIsOpeningSignal = openingAsk && chosenCards.every(card =>
    card.rank < 15 && cardStrength(card, ctx) >= trumpAceStrength
  );

  if (openingAsk && chosen.provisionalLeaderSeat !== view.you.seat) {
    const takeover = openingTakeoverChoices
      .sort((a, b) => a.preserveCost - b.preserveCost)[0] ?? null;
    if (takeover) {
      record.issues.push({
        type: 'OPENING_CONTROL',
        alternativeLabels: labels(takeover.cards),
        text: '回应庄家首轮吊主时本可取得牌权，却没有争到下一轮的表示机会',
      });
    } else if (chosenIsOpeningSignal) {
      const lowAlternative = openingNonJokerChoices
        .filter(choice => choice.preserveCost < chosen.preserveCost)
        .sort((a, b) => a.preserveCost - b.preserveCost)[0] ?? null;
      if (lowAlternative) {
        record.issues.push({
          type: 'OPENING_CONTROL',
          alternativeLabels: labels(lowAlternative.cards),
          text: '打出的大主仍无法取得牌权，没有换来下一轮的表示机会',
        });
      }
    }
  }

  const openingJokerWaste = openingAsk && chosenCards.some(card => card.rank >= 15);
  if (openingJokerWaste || (openingAsk && chosen.spentLastBigJoker)) {
    const pool = openingTakeoverChoices.length > 0
      ? openingTakeoverChoices
      : openingNonJokerChoices;
    const alternative = pool.sort((a, b) => a.preserveCost - b.preserveCost)[0] ?? null;
    if (alternative) {
      record.issues.push({
        type: 'CONTROL_WASTE',
        alternativeLabels: labels(alternative.cards),
        text: '回应庄家首轮吊主时用鬼做普通表示，浪费了保底控制',
      });
    }
  }

  if (chosen.lastSeatPointRisk > 0) {
    const alternative = choices
      .filter(choice => choice.provisionalLeaderSeat % 2 === record.team)
      .filter(choice => choice.lastSeatPointRisk < chosen.lastSeatPointRisk)
      .sort(
        (a, b) =>
          a.lastSeatPointRisk - b.lastSeatPointRisk ||
          a.preserveCost - b.preserveCost
      )[0] ?? null;
    if (alternative) {
      record.issues.push({
        type: 'LAST_SEAT_POINT',
        alternativeLabels: labels(alternative.cards),
        text: `第三手没有封住牌面，最后一家仍可能用分牌反超（风险 ${chosen.lastSeatPointRisk} 分）`,
      });
    }
  }

  if (opponentProbe && donatedPieces.length > 0 && unseenPieces > 0) {
    const alternative = betterAlternative(
      choices,
      chosen,
      choice => choice.pieceCount < chosen.pieceCount
    );
    if (alternative) {
      record.issues.push({
        type: 'PIECE_HELP',
        alternativeLabels: labels(alternative.cards),
        text: `对手用小牌探件时打出 ${labels(donatedPieces)}，帮对手消掉了未现件`,
      });
    }
  }

  if (!partnerSideProtocol && playersBehind > 0 && chosen.pointValue > 0) {
    const alternative = betterAlternative(
      choices,
      chosen,
      choice => choice.pointValue < chosen.pointValue
    );
    if (alternative) {
      record.issues.push({
        type: 'UNSAFE_POINT',
        alternativeLabels: labels(alternative.cards),
        text: `后面还有 ${playersBehind} 家未出时暴露了 ${chosen.pointValue} 分`,
      });
    }
  }

  const lowerCost = partnerSideProtocol
    ? null
    : betterAlternative(
      choices,
      chosen,
      choice =>
        choice.pointValue <= chosen.pointValue &&
        choice.pieceCount <= chosen.pieceCount &&
        choice.preserveCost + 12 < chosen.preserveCost
    );
  if (lowerCost) {
    record.issues.push({
      type: 'OVERPLAY',
      alternativeLabels: labels(lowerCost.cards),
      text: `用牌过大，当时的暂时领先结果用 ${labels(lowerCost.cards)} 也能达到`,
    });
  }
  return record;
}

export class BotReviewJournal {
  constructor() {
    this.records = [];
    // 按 RoundSummary 对象标记，避免“新开一局”后 roundNumber 从 1 重置时冲突。
    this.finalizedSummaries = new WeakSet();
  }

  record(view, action) {
    if (action?.type !== 'play' || !view?.round) return null;
    const record = inspectBotPlay(view, action);
    this.records.push(record);
    return record;
  }

  discard(record) {
    if (!record) return;
    this.records = this.records.filter(item => item !== record);
  }

  finalizeCompletedRounds(state) {
    for (const summary of state.rounds ?? []) {
      if (this.finalizedSummaries.has(summary)) continue;
      const records = this.records.filter(record => record.roundNumber === summary.roundNumber);
      if (records.length === 0) continue;
      const trickHistory = state.round?.roundNumber === summary.roundNumber
        ? state.round.trickHistory ?? []
        : [];
      const issues = [];
      const learning = learningFor(state);
      const shared = learning.shared;
      const representedTeams = new Set(records.map(record => record.team));

      shared.roundsReviewed += 1;
      shared.playsReviewed += records.length;
      updateBottomLearning(shared, summary, representedTeams);

      for (const record of records) {
        const profile = profileFor(learning, record.playerId);
        profile.reviewedPlays += 1;
        const trick = trickHistory.find(item => item.trickNo === record.trickNo);
        const lost = trick ? trick.winnerSeat % 2 !== record.team : null;
        for (const issue of record.issues) {
          if (issue.type === 'PIECE_HELP') {
            profile.pieceCaution = Math.min(3, profile.pieceCaution + 0.12);
            shared.pieceCaution = Math.min(3, shared.pieceCaution + 0.05);
          } else if (issue.type === 'UNSAFE_POINT') {
            profile.pointCaution = Math.min(3, profile.pointCaution + (lost ? 0.12 : 0.05));
            shared.pointCaution = Math.min(3, shared.pointCaution + (lost ? 0.05 : 0.02));
          } else if (issue.type === 'OVERPLAY') {
            profile.overplayCaution = Math.min(3, profile.overplayCaution + 0.05);
            shared.overplayCaution = Math.min(3, shared.overplayCaution + 0.02);
          } else if (issue.type === 'LAST_SEAT_POINT') {
            profile.coverCaution = Math.min(3, profile.coverCaution + (lost ? 0.12 : 0.06));
            shared.coverCaution = Math.min(3, shared.coverCaution + (lost ? 0.05 : 0.025));
          } else if (issue.type === 'CONTROL_WASTE') {
            profile.controlCaution = Math.min(3, profile.controlCaution + 0.12);
            shared.controlCaution = Math.min(3, shared.controlCaution + 0.05);
          } else if (issue.type === 'OPENING_CONTROL') {
            profile.controlCaution = Math.min(3, profile.controlCaution + (lost ? 0.12 : 0.06));
            shared.controlCaution = Math.min(3, shared.controlCaution + (lost ? 0.05 : 0.025));
          }
          issues.push({ ...issue, ...record, lost });
        }
      }

      const counts = {
        pieceHelp: issues.filter(issue => issue.type === 'PIECE_HELP').length,
        unsafePoint: issues.filter(issue => issue.type === 'UNSAFE_POINT').length,
        overplay: issues.filter(issue => issue.type === 'OVERPLAY').length,
        lastSeatPoint: issues.filter(issue => issue.type === 'LAST_SEAT_POINT').length,
        controlWaste: issues.filter(issue => issue.type === 'CONTROL_WASTE').length,
        openingControl: issues.filter(issue => issue.type === 'OPENING_CONTROL').length,
      };
      summary.botReview = {
        reviewedPlays: records.length,
        issueCount: issues.length,
        counts,
        learning: learningSnapshot(shared),
        examples: issues.slice(0, 5).map(issue =>
          `${issue.nickname}第 ${issue.trickNo} 轮：${issue.text}；更稳的候选是 ${issue.alternativeLabels}` +
          `${issue.lost === true ? '，本轮最终被对手拿走' : ''}`
        ),
      };
      this.finalizedSummaries.add(summary);
      this.records = this.records.filter(record => record.roundNumber !== summary.roundNumber);
    }
  }
}
