import { playerById } from './state.js';
import { countTrump, playSuitOf } from './cards.js';
import { pieceStatusesFor } from './pieces.js';
import { crossRiverCandidates } from './crossriver.js';
import { collectLeakedCards } from './security.js';

// 轮局状态裁剪：只暴露公开信息。
// 牌面数据的公开白名单：
// - you.hand / you.exchangeKitty：观看者本人
// - flipShown / fallbackRevealed：揭牌定主流程中公开摊开的牌
// - currentTrick / lastTrick / trickHistory：已打出的牌
function clipRound(round, viewerSeat) {
  if (!round) return null;
  const ctx = { trumpSuit: round.trumpSuit, rankCard: round.rankCard };

  // 件追踪公开视图：'mine' / 'seen'（已打出或底牌亮出）/ 'unseen'（在别人暗牌里）
  // 不携带 cardId —— 不泄露任何暗牌信息；四家除 mine 外完全一致。
  const piecesView =
    Array.isArray(round.pieces) && round.pieces.length > 0
      ? pieceStatusesFor(round.pieces, round.trumpSuit, viewerSeat)
      : null;

  return {
    roundNumber: round.roundNumber,
    declarerSeat: round.declarerSeat,
    trumpSuit: round.trumpSuit,
    rankCard: round.rankCard,
    revealTurnSeat: round.revealTurnSeat,
    drawnCount: round.drawnCount,
    drawDeadline: round.drawDeadline,
    graceDeadline: round.graceDeadline,
    fallbackSuit: round.fallbackSuit,
    flipShown: round.flipShown,            // 公开：翻牌定起揭人翻出的牌
    flipDone: round.flipDone === true,
    // 起揭人已定后的停留：确认名单与截止时刻（公开，四端同步倒计时）
    flipConfirms: [...(round.flipConfirms ?? [])],
    flipHoldDeadline: round.flipHoldDeadline ?? null,
    fallbackRevealed: round.fallbackRevealed, // 公开：揭底定主摊开的底牌
    // 关键节点大图（均为公开信息）：
    flipEvent: round.flipEvent ?? null,        // 翻牌定起揭人：最近一次翻牌 {kind,card,starterSeat?,ts}
    trumpEvent: round.trumpEvent ?? null,      // 亮主：{card,declarerSeat,wasFirstRound,ts}
    fallbackTrumpCard: round.fallbackTrumpCard ?? null, // 揭底定主：定主的那张底牌
    // 三主过河（公开状态；giveCardIds 不外发——换的牌只有当事两人知道）
    crossRiver: round.crossRiver
      ? {
          doneTeams: [...round.crossRiver.doneTeams],
          passedSeats: [...round.crossRiver.passedSeats],
          active: round.crossRiver.active.map(a => ({
            fromSeat: a.fromSeat,
            toSeat: a.toSeat,
            deadline: a.deadline,
          })),
          decideDeadline: round.crossRiver.decideDeadline,
          declarerCrossedRiver: round.declarerCrossedRiver === true,
        }
      : null,
    kittyDeadline: round.kittyDeadline ?? null,
    dominanceDeadline: round.dominanceDeadline ?? null,
    leadSeat: round.leadSeat,
    turnSeat: round.turnSeat,
    playDeadline: round.playDeadline,
    currentTrick: round.currentTrick,
    lastTrick: round.lastTrick,
    settleDeadline: round.settleDeadline,
    trickHistory: round.trickHistory,
    dominance: round.dominance ?? null,
    // 本局小结：已确认的座位（公开）+ 停留截止时刻（四端同步倒计时）
    roundEndConfirms: [...(round.roundEndConfirms ?? [])],
    roundEndDeadline: round.roundEndDeadline ?? null,
    defenderTrickPoints: round.defenderTrickPoints,
    runAwayPoints: round.runAwayPoints,
    defenderPoints: round.defenderPoints,
    kittyPoints: round.kittyPoints,
    kittyCount: Array.isArray(round.kitty) ? round.kitty.length : 0,
    // 埋入底牌中被系统公开亮出的件（A/K）：牌桌底牌行以明牌显示，其余为牌背
    kittyRevealedPieces: (round.pieces ?? [])
      .filter(p => p.location.kind === 'kittyRevealed')
      .map(p => ({ suit: p.suit, rank: p.rank })),
    piecesView,
  };
}

// 自己的手牌构成（只给本人）：主牌数 + 各副牌花色张数。
// 绝不下发给他人（否则等于摊牌）——保密断言覆盖。
function ownComposition(hand, ctx) {
  const comp = { trump: 0, S: 0, H: 0, D: 0, C: 0 };
  for (const c of hand) {
    const s = playSuitOf(c, ctx.trumpSuit, ctx.rankCard);
    if (s === 'TRUMP') comp.trump += 1;
    else comp[s] += 1;
  }
  return comp;
}

// 按玩家裁剪的公开视图。
// 安全底线：裁剪完成后递归扫描整个 payload，出现任何白名单外的
// 牌面数据（Card 形状对象）直接抛错 —— 不静默。
export function viewerState(state, viewerId) {
  const you = playerById(state, viewerId);
  if (!you) return null;

  const ctx = state.round
    ? { trumpSuit: state.round.trumpSuit, rankCard: state.round.rankCard }
    : { trumpSuit: null, rankCard: 2 };

  const players = [...state.players]
    .sort((a, b) => a.seat - b.seat)
    .map(p => ({
      id: p.id,
      nickname: p.nickname,
      seat: p.seat,
      team: p.team,
      connected: p.connected,
      isBot: p.isBot === true,
      ready: p.ready,
      seatLocked: p.seatLocked,
      handCount: Array.isArray(p.hand) ? p.hand.length : 0, // 只给张数，不给牌
      isDeclarer: state.declarerSeat !== null && state.declarerSeat === p.seat,
      isFlipper: state.flipperSeat !== null && state.flipperSeat === p.seat,
    }));

  // 结算/小结阶段：8 张底牌公开揭晓（四家可见）
  const kittyRevealed =
    (state.phase === 'SCORING' || state.phase === 'ROUND_END' || state.phase === 'GAME_OVER') &&
    Array.isArray(state.round?.kitty)
      ? state.round.kitty
      : null;

  // 碾压判定阶段：摊开四家剩余手牌（局已结束，不涉及泄密）
  const allHandsRevealed =
    state.phase === 'DOMINANCE'
      ? state.players.map(p => ({ seat: p.seat, cards: p.hand }))
      : null;

  // 过河阶段：候选座位（只用于本人视角的能力位，不下发数组本身）
  const crossCandidates =
    state.round && state.phase === 'CROSS_RIVER' ? crossRiverCandidates(state) : [];

  const payload = {
    phase: state.phase,
    you: {
      id: you.id,
      nickname: you.nickname,
      seat: you.seat,
      team: you.team,
      connected: you.connected,
      isBot: you.isBot === true,
      ready: you.ready,
      seatLocked: you.seatLocked,
      isAdmin: Array.isArray(state.adminIds) && state.adminIds.includes(you.id),
      hand: Array.isArray(you.hand) ? you.hand : [], // 仅本人手牌（已排序；换底时庄家为 33 张）
      trumpCount: countTrump(you.hand, ctx),
      composition: ownComposition(you.hand, ctx),
      // 三主过河：只给本人视角的能力位（不给别人的候选状态，避免泄露手牌构成）
      crossRiver: {
        eligible: crossCandidates.includes(you.seat), // 我可以发起（主牌≤3 且对家副牌≥3）
        mustRespond: (state.round?.crossRiver?.active ?? []).some(a => a.toSeat === you.seat), // 我要回 3 副
        waiting: (state.round?.crossRiver?.active ?? []).some(a => a.fromSeat === you.seat), // 我已发起，等对家
      },
    },
    players,
    teamLevels: [...state.teamLevels],
    declarerSeat: state.declarerSeat,
    flipperSeat: state.flipperSeat,
    swapProposals: state.swapProposals.map(sp => ({ fromSeat: sp.fromSeat, toSeat: sp.toSeat })),
    // 新开一局提案（公开状态：发起人、已同意座位、座位选项、截止时刻）
    // 暂停状态（公开）：谁暂停的、是不是自动暂停、从什么时候开始
    paused: state.paused
      ? {
          bySeat: state.paused.bySeat ?? null,
          auto: state.paused.auto === true,
          at: state.paused.at,
        }
      : null,
    resetProposal: state.resetProposal
      ? {
          fromSeat: state.resetProposal.fromSeat,
          yesSeats: [...state.resetProposal.yesSeats],
          reshuffleSeats: state.resetProposal.reshuffleSeats,
          deadline: state.resetProposal.deadline,
        }
      : null,
    round: state.round
      ? { ...clipRound(state.round, you.seat), kittyRevealed, allHandsRevealed }
      : null,
    rounds: state.rounds.slice(-50), // 本局历史（公开摘要）
    log: state.log.slice(-200),
    chat: state.chat.slice(-200),
    gameWinnerTeam: state.gameWinnerTeam,
  };

  // 安全底线：白名单之外的任何牌面数据 → 抛错（不静默）
  const leaks = collectLeakedCards(payload, [
    'you.hand',
    'round.kittyRevealed',
    'round.allHandsRevealed',
    'round.flipShown',
    'round.fallbackRevealed',
    'round.flipEvent',
    'round.trumpEvent',
    'round.fallbackTrumpCard',
    'round.currentTrick',
    'round.lastTrick',
    'round.trickHistory',
  ]);
  if (leaks.length > 0) {
    throw new Error(
      `[安全底线] 状态包含非公开牌面数据: ${leaks.map(l => l.path).join(', ')}`
    );
  }
  return payload;
}
