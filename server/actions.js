import { PLAYERS, PLAYER_COUNT, QUICK_PHRASES, KITTY_SIZE, REVEAL_TOTAL, SUIT_NAMES, CROSS_RIVER_DECIDE_MS, CROSS_RIVER_PICK_MS, rollSuppressedEgg } from './constants.js';
import { playerById, playerBySeat, pushLog, resetGameState } from './state.js';
import { chooseRevealEntry, advanceToReadyCheck, startRevealing } from './flow.js';
import { beginRound, drawOneCard } from './round.js';
import { isRankCard, cardLabel, sortHand } from './cards.js';
import { rebuildPieces, pieceStatusesFor, migratePlayedPieces, trumpDumpVerdict, relocateTableCards } from './pieces.js';
import { validateLeadPlay, validateFollowPlay, resolveTrick, trickLeader, assertEqualHandCounts } from './trick.js';
import { finishRound, TEAM_NAMES } from './scoring.js';
import { checkDominance } from './dominance.js';
import { nextSeat, oppositeSeat } from './rotation.js';
import { autoPauseApplies, hasConnectedHuman, pauseGame, resumeGame } from './pause.js';
import {
  crossRiverCandidates,
  validateRiverGive,
  validateRiverBack,
  executeCrossRiver,
  pickLowestSideCards,
} from './crossriver.js';

// 错误码（与协议文档一致，随阶段推进扩充）
export const ErrorCode = {
  UNKNOWN_PLAYER: 'UNKNOWN_PLAYER',
  NOT_JOINED: 'NOT_JOINED',
  BAD_ACTION: 'BAD_ACTION',
  WRONG_PHASE: 'WRONG_PHASE',
  SEAT_LOCKED: 'SEAT_LOCKED',
  SWAP_REJECTED: 'SWAP_REJECTED',
  FLIPPER_ALREADY_CLAIMED: 'FLIPPER_ALREADY_CLAIMED',
  CHAT_INVALID: 'CHAT_INVALID',
  // 阶段2
  NOT_YOUR_DRAW_TURN: 'NOT_YOUR_DRAW_TURN',
  TRUMP_ALREADY_DECLARED: 'TRUMP_ALREADY_DECLARED',
  CARD_NOT_RANK_CARD: 'CARD_NOT_RANK_CARD',
  CARDS_NOT_IN_HAND: 'CARDS_NOT_IN_HAND',
  NOT_DECLARER: 'NOT_DECLARER',
  WRONG_COUNT: 'WRONG_COUNT',
  // 阶段3
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  WAIT_SETTLE: 'WAIT_SETTLE',
  // 阶段5
  STALE_STATE: 'STALE_STATE',
  // 暂停
  PAUSED: 'PAUSED',
  NOT_PAUSED: 'NOT_PAUSED',
  // 阶段6
  PROPOSAL_ACTIVE: 'PROPOSAL_ACTIVE',
  ALREADY_VOTED: 'ALREADY_VOTED',
  FORBIDDEN: 'FORBIDDEN',
  BOT_UNAVAILABLE: 'BOT_UNAVAILABLE',
  // 阶段7（三主过河）
  CROSS_RIVER_NOT_ELIGIBLE: 'CROSS_RIVER_NOT_ELIGIBLE',
  CROSS_RIVER_TEAM_ACTIVE: 'CROSS_RIVER_TEAM_ACTIVE',
  CROSS_RIVER_DONE: 'CROSS_RIVER_DONE',
  CROSS_RIVER_NO_WAIT: 'CROSS_RIVER_NO_WAIT',
  // 出牌规则错误码来自 trick.js（MUST_FOLLOW_SUIT / NOT_ENOUGH_SUIT /
  // THROW_MIXED_SUIT / THROW_NOT_ELIGIBLE 等）
};

function fail(code, reason) {
  return { ok: false, error: { code, reason } };
}

function succeed(extra = {}) {
  return { ok: true, ...extra };
}

// 交换两个座位（队伍随之重算：team = seat % 2）
function swapSeats(state, seatA, seatB) {
  const pa = playerBySeat(state, seatA);
  const pb = playerBySeat(state, seatB);
  state.seatsByPlayer[pa.id] = seatB;
  state.seatsByPlayer[pb.id] = seatA;
  pa.seat = seatB;
  pa.team = seatB % 2;
  pb.seat = seatA;
  pb.team = seatA % 2;
}

// 清除涉及某座位的换座请求
function clearProposalsFor(state, seat) {
  state.swapProposals = state.swapProposals.filter(
    sp => sp.fromSeat !== seat && sp.toSeat !== seat
  );
}

// ---- 登录 / 掉线 ----

// 上线播报的冷却窗口：网络抖动会让同一个人反复 join，
// 不设冷却就会连弹好几条「XX 已上线」。不另存状态，直接看最近的日志 ——
// 这样存档恢复、进程重启后冷却依然有效。
const ONLINE_ANNOUNCE_COOLDOWN_MS = 60000;

function announceOnline(state, player, suffix = '') {
  const now = Date.now();
  const justAnnounced = state.log.some(
    l => l.event === 'ONLINE' && l.playerId === player.id && now - l.ts < ONLINE_ANNOUNCE_COOLDOWN_MS
  );
  const text = `${player.nickname} 已上线${suffix}，大家欢迎！`;
  // 冷却期内仍然记一条普通日志（流水账不能断），只是不带 event —— 客户端就不会弹提示。
  pushLog(state, text, justAnnounced ? null : { event: 'ONLINE', playerId: player.id });
}

export function handleJoin(state, action, actorId) {
  if (!PLAYERS.some(p => p.id === actorId)) return fail(ErrorCode.UNKNOWN_PLAYER, '未知身份');
  const me = playerById(state, actorId);
  // 真人进来直接顶掉电脑，任何阶段都可以（牌局进行中也能接手，手牌原样继承）。
  // 原来是拒绝登录、要求先去大厅移除电脑 —— 但电脑正在打的时候大厅按钮根本不可用，
  // 等于真人回来了却进不去自己的位置。
  if (me.isBot) {
    me.isBot = false;
    me.connected = true;
    announceOnline(state, me, '，接管了电脑玩家的位置');
    return succeed();
  }
  // 已经在线时重复 join（同一人开第二个标签页 / 断线重连顶替）不再播报：
  // 这不是「上线」，弹提示只会打扰另外三家。
  if (!me.connected) {
    me.connected = true;
    announceOnline(state, me);
  }
  return succeed();
}

// ---- 电脑玩家（仅开局前可增删）----

function botLobbyAllowed(state) {
  return state.phase === 'SEATING' || state.phase === 'READY_CHECK';
}

function humanManager(state, actorId) {
  const actor = playerById(state, actorId);
  return actor && actor.connected && !actor.isBot ? actor : null;
}

// 加电脑：开局前给任何空位放电脑；牌局进行中【只能】给掉线的座位接管。
//
// ⚠️ 这里原来一律要求 botLobbyAllowed，于是有个死局：
// 真人接管了电脑位、打到一半掉线，那个座位就永远卡在「掉线」——
// handleJoin 只让真人顶掉电脑，handleLeave 只置 connected=false，
// 而加电脑又被阶段挡住，谁也接不了手，全场只能靠「新开一局」把整局作废。
// 真人任何阶段都能顶掉电脑（见 handleJoin），电脑也就该能任何阶段接管掉线的人，
// 两边对称。手牌原样继承，和真人接管电脑位完全一样。
export function handleAddBot(state, action, actorId) {
  const actor = humanManager(state, actorId);
  if (!actor) return fail(ErrorCode.FORBIDDEN, '只有房间中的真人玩家可以添加电脑');
  const target = playerById(state, action.playerId);
  if (!target) return fail(ErrorCode.UNKNOWN_PLAYER, '未知身份');
  if (target.connected || target.isBot) {
    return fail(ErrorCode.BOT_UNAVAILABLE, '该位置已经有人或电脑');
  }
  const inLobby = botLobbyAllowed(state);
  target.isBot = true;
  target.connected = true;
  target.ready = false;
  if (state.phase === 'READY_CHECK') target.seatLocked = true;
  clearProposalsFor(state, target.seat);
  pushLog(
    state,
    inLobby
      ? `${actor.nickname} 将 ${target.nickname} 设为电脑玩家`
      : `${actor.nickname} 让电脑接管了掉线的 ${target.nickname}（手牌原样继承）`
  );
  return succeed();
}

// 移除电脑仍然只能在开局前：牌局进行中把电脑撤掉会留下一个没人打的空位，
// 比掉线还糟。真人想回来直接 join 顶掉它就行（handleJoin，任何阶段都可以）。
export function handleRemoveBot(state, action, actorId) {
  if (!botLobbyAllowed(state)) return fail(ErrorCode.WRONG_PHASE, '只能在开局前移除电脑');
  const actor = humanManager(state, actorId);
  if (!actor) return fail(ErrorCode.FORBIDDEN, '只有房间中的真人玩家可以移除电脑');
  const target = playerById(state, action.playerId);
  if (!target) return fail(ErrorCode.UNKNOWN_PLAYER, '未知身份');
  if (!target.isBot) return fail(ErrorCode.BOT_UNAVAILABLE, '该位置不是电脑玩家');
  target.isBot = false;
  target.connected = false;
  target.ready = false;
  if (state.phase === 'SEATING') target.seatLocked = false;
  clearProposalsFor(state, target.seat);
  pushLog(state, `${actor.nickname} 移除了电脑玩家 ${target.nickname}`);
  return succeed();
}

export function handleLeave(state, action, actorId) {
  const me = playerById(state, actorId);
  if (!me) return fail(ErrorCode.UNKNOWN_PLAYER, '未知身份');
  me.connected = false;
  pushLog(state, `${me.nickname} 掉线`);
  // 全场只剩电脑 → 自动暂停。不然四个电脑会自顾自把整局打完，
  // 真人回来时战局早就结束了，连复盘都来不及看。
  if (!state.paused && autoPauseApplies(state) && !hasConnectedHuman(state)) {
    pauseGame(state, { auto: true });
    pushLog(state, '真人玩家已全部离线，游戏自动暂停。任何真人上线后可恢复。');
  }
  return succeed();
}

// ---- 暂停 / 恢复 ----

export function handlePause(state, action, actorId) {
  const me = playerById(state, actorId);
  if (!me) return fail(ErrorCode.UNKNOWN_PLAYER, '未知身份');
  // 与「电脑不能恢复」对称：暂停是给真人用的
  if (me.isBot) return fail(ErrorCode.FORBIDDEN, '电脑不能暂停游戏');
  if (state.paused) return fail(ErrorCode.PAUSED, '游戏已经处于暂停状态');
  pauseGame(state, { bySeat: me.seat, auto: false });
  pushLog(state, `${me.nickname} 暂停了游戏`);
  return succeed();
}

export function handleResume(state, action, actorId) {
  const me = playerById(state, actorId);
  if (!me) return fail(ErrorCode.UNKNOWN_PLAYER, '未知身份');
  // 电脑不能恢复：自动暂停本来就是为了等真人回来，让电脑自己解除毫无意义
  if (me.isBot) return fail(ErrorCode.FORBIDDEN, '电脑不能恢复游戏');
  if (!state.paused) return fail(ErrorCode.NOT_PAUSED, '游戏当前没有暂停');
  const elapsed = resumeGame(state);
  pushLog(state, `${me.nickname} 恢复了游戏（暂停了 ${Math.round(elapsed / 1000)} 秒）`);
  return succeed();
}

// ---- 座位与换座（SEATING，仅游戏开始一次）----

export function handleProposeSwap(state, action, actorId) {
  if (state.phase !== 'SEATING') return fail(ErrorCode.WRONG_PHASE, '当前阶段不能换座');
  const me = playerById(state, actorId);
  const targetSeat = action.targetSeat;
  if (!Number.isInteger(targetSeat) || targetSeat < 0 || targetSeat > 3) {
    return fail(ErrorCode.SWAP_REJECTED, '目标座位无效');
  }
  if (me.seatLocked) return fail(ErrorCode.SEAT_LOCKED, '你已确认座位，不能换座');
  const target = playerBySeat(state, targetSeat);
  if (target.seat === me.seat) return fail(ErrorCode.SWAP_REJECTED, '不能与自己换座');
  if (target.seatLocked) return fail(ErrorCode.SEAT_LOCKED, '对方已确认座位，不能换座');
  // 服务端裁决：同一人重复请求则覆盖旧请求
  clearProposalsFor(state, me.seat);
  state.swapProposals.push({ fromSeat: me.seat, toSeat: targetSeat });
  pushLog(state, `${me.nickname} 请求与 ${target.nickname} 交换座位`);
  return succeed();
}

export function handleAcceptSwap(state, action, actorId) {
  if (state.phase !== 'SEATING') return fail(ErrorCode.WRONG_PHASE, '当前阶段不能换座');
  const me = playerById(state, actorId);
  if (me.seatLocked) return fail(ErrorCode.SEAT_LOCKED, '你已确认座位，不能换座');
  const proposal = state.swapProposals.find(
    sp => sp.toSeat === me.seat && sp.fromSeat === action.fromSeat
  );
  if (!proposal) return fail(ErrorCode.SWAP_REJECTED, '没有待确认的换座请求');
  const other = playerBySeat(state, proposal.fromSeat);
  swapSeats(state, me.seat, other.seat);
  clearProposalsFor(state, me.seat);
  clearProposalsFor(state, other.seat);
  pushLog(state, `${me.nickname} 与 ${other.nickname} 交换了座位`);
  return succeed();
}

// 换座请求拒绝（阶段7：全屏确认框的“拒绝”按钮）
export function handleDeclineSwap(state, action, actorId) {
  if (state.phase !== 'SEATING') return fail(ErrorCode.WRONG_PHASE, '当前阶段不能换座');
  const me = playerById(state, actorId);
  const before = state.swapProposals.length;
  state.swapProposals = state.swapProposals.filter(
    sp => !(sp.toSeat === me.seat && sp.fromSeat === action.fromSeat)
  );
  if (state.swapProposals.length === before) {
    return fail(ErrorCode.SWAP_REJECTED, '没有待确认的换座请求');
  }
  pushLog(state, `${me.nickname} 拒绝了换座请求`);
  return succeed();
}

export function handleConfirmSeat(state, action, actorId) {
  if (state.phase !== 'SEATING') return fail(ErrorCode.WRONG_PHASE, '当前阶段不能确认座位');
  const me = playerById(state, actorId);
  if (me.seatLocked) return fail(ErrorCode.SEAT_LOCKED, '你已确认过座位');
  me.seatLocked = true;
  clearProposalsFor(state, me.seat);
  pushLog(state, `${me.nickname} 确认座位`);
  return succeed();
}

// ---- 准备（READY_CHECK）----

export function handleReady(state, action, actorId) {
  if (state.phase !== 'READY_CHECK') return fail(ErrorCode.WRONG_PHASE, '当前阶段不能准备');
  const me = playerById(state, actorId);
  me.ready = !me.ready;
  if (!state.players.every(p => p.ready)) {
    pushLog(state, `${me.nickname} ${me.ready ? '已准备' : '取消准备'}`);
    return succeed();
  }
  // 全员准备 → 建牌组洗牌 → 进入揭牌定主流程（判据：庄家是否已确定，与第几局无关）
  const target = chooseRevealEntry(state);
  beginRound(state);
  state.phase = target;
  state.flipperSeat = null;
  for (const p of state.players) p.ready = false;
  pushLog(state, target === 'REVEAL_FIRST'
    ? '全员准备完成，请抢按「揭牌」成为翻牌人。'
    : '全员准备完成，庄家开始揭牌。');
  return succeed();
}

// ---- 抢按揭牌人（REVEAL_FIRST，服务端先到先得）----

export function handleClaimFlipper(state, action, actorId) {
  if (state.phase !== 'REVEAL_FIRST') return fail(ErrorCode.WRONG_PHASE, '当前阶段不能揭牌');
  if (state.flipperSeat !== null) return fail(ErrorCode.FLIPPER_ALREADY_CLAIMED, '已有人先揭牌');
  const me = playerById(state, actorId);
  state.flipperSeat = me.seat;
  pushLog(state, `${me.nickname} 已揭牌，系统开始翻牌定起揭人。`);
  return succeed();
}

// ---- 起揭人已定的停留确认（REVEAL_FIRST）----
// 翻牌定出起揭人后停 10 秒，让四个人看清翻的是什么牌、点数怎么换算、轮到谁先揭。
// 四人都点「知道了」就提前开揭；没点满等满 10 秒照常开始（掉线的人不会卡住全场）。

export function handleConfirmFlip(state, action, actorId) {
  if (state.phase !== 'REVEAL_FIRST') return fail(ErrorCode.WRONG_PHASE, '当前阶段无需确认');
  const r = state.round;
  if (!r || !r.flipDone) return fail(ErrorCode.WRONG_PHASE, '起揭人还没定出来');
  const me = playerById(state, actorId);
  if (r.flipConfirms.includes(me.seat)) return fail(ErrorCode.ALREADY_VOTED, '你已经确认过了');
  r.flipConfirms.push(me.seat);
  pushLog(state, `${me.nickname} 知道了（${r.flipConfirms.length}/4）`);
  if (r.flipConfirms.length >= PLAYER_COUNT) startRevealing(state);
  return succeed();
}

// ---- 揭牌（REVEALING，手动逐张 + 3秒超时自动摸，由引擎计时）----

export function handleDrawCard(state, action, actorId) {
  if (state.phase !== 'REVEALING') return fail(ErrorCode.WRONG_PHASE, '当前阶段不能揭牌');
  const r = state.round;
  if (r.drawnCount >= REVEAL_TOTAL) return fail(ErrorCode.WRONG_PHASE, '揭牌已完成');
  const me = playerById(state, actorId);
  if (me.seat !== r.revealTurnSeat) return fail(ErrorCode.NOT_YOUR_DRAW_TURN, '还没轮到你揭牌');
  const card = drawOneCard(state, me.seat);
  r.drawDeadline = Date.now() + (state.timing ? state.timing.drawMs : 3000);
  // 注意：日志不得包含摸到的牌面（只有摸牌者可见）
  return succeed({ drawnCardId: card.id });
}

// ---- 亮主（REVEALING，抢按 + 携带 cardId，与揭牌回合无关）----

export function handleDeclareTrump(state, action, actorId) {
  if (state.phase !== 'REVEALING') return fail(ErrorCode.WRONG_PHASE, '当前阶段不能亮主');
  const r = state.round;
  if (r.trumpSuit) return fail(ErrorCode.TRUMP_ALREADY_DECLARED, '已有人先亮主');
  const me = playerById(state, actorId);
  const card = me.hand.find(c => c.id === action.cardId);
  if (!card) return fail(ErrorCode.CARDS_NOT_IN_HAND, '这张牌不在你手上');
  if (!isRankCard(card, r.rankCard)) return fail(ErrorCode.CARD_NOT_RANK_CARD, '这张牌不是级牌');
  // 亮主一次性：第一人亮定，无反主/加主。
  // 第一局：亮牌者即庄家；第二局起：庄家已由轮转确定，亮主只影响主牌花色，不改变庄家归属。
  r.trumpSuit = card.suit;
  const wasFirstRound = state.declarerSeat === null;
  if (state.declarerSeat === null) state.declarerSeat = me.seat;
  r.trumpEvent = {
    card,
    declarerSeat: me.seat,
    wasFirstRound,
    ts: Date.now(),
  }; // 客户端中央大图：亮出的级牌 + “XX 亮红桃2，主牌为红桃”（第一局补“成为庄家”）
  state.phase = 'DEALING';
  pushLog(state, `${me.nickname} 亮主：${cardLabel(card)}，主牌为 ${SUIT_NAMES[card.suit]}`);
  return succeed();
}

// ---- 庄家换底（KITTY_EXCHANGE）----
// 底牌已并进庄家手牌（33 张统一排序），庄家从中点选 8 张压回底牌。

export function handleBuryKitty(state, action, actorId) {
  if (state.phase !== 'KITTY_EXCHANGE') return fail(ErrorCode.WRONG_PHASE, '当前阶段不能换底');
  const me = playerById(state, actorId);
  if (me.seat !== state.declarerSeat) return fail(ErrorCode.NOT_DECLARER, '只有庄家能换底');
  const ids = action.cardIds;
  if (!Array.isArray(ids) || ids.length !== KITTY_SIZE || new Set(ids).size !== KITTY_SIZE) {
    return fail(ErrorCode.WRONG_COUNT, `必须恰好埋 ${KITTY_SIZE} 张牌`);
  }
  const r = state.round;
  // 换底池 = 庄家手牌（25 张 + 底牌 8 张已合并，共 33 张）
  const buried = ids.map(id => me.hand.find(c => c.id === id));
  if (buried.some(c => !c)) return fail(ErrorCode.CARDS_NOT_IN_HAND, '所选牌不在你手上');
  me.hand = me.hand.filter(c => !ids.includes(c.id));
  r.kitty = buried;
  me.hand = sortHand(me.hand, { trumpSuit: r.trumpSuit, rankCard: r.rankCard });

  // 埋入的副牌 A/K（件）系统自动公开亮给全桌：庄家不能隐瞒
  for (const c of buried) {
    if (c.suit !== 'JOKER' && c.suit !== r.trumpSuit && (c.rank === 13 || c.rank === 14)) {
      pushLog(state, `庄家埋底亮出：${cardLabel(c)}`);
    }
  }
  // 件去向表重建：每张件在谁手上 / 在底牌里（同时重建主牌去向表，供主牌甩牌资格判定）
  rebuildPieces(state);

  r.leadSeat = me.seat;
  r.turnSeat = me.seat;
  // 换底 → 三主过河（CROSS_RIVER）：无人符合条件时直接进入出牌
  r.crossRiver.doneTeams = [];
  r.crossRiver.passedSeats = [];
  r.crossRiver.active = [];
  r.crossRiver.decideDeadline = Date.now() + (state.timing ? state.timing.crossRiverDecideMs : CROSS_RIVER_DECIDE_MS);
  state.phase = 'CROSS_RIVER';
  pushLog(state, '换底完成。主牌 ≤3 张者可发起三主过河（15 秒内），无人发起将直接进入出牌。');
  maybeFinishCrossRiver(state);
  return succeed();
}

// ---- 三主过河（CROSS_RIVER，庄家换底后、出牌前插入的独立阶段）----
// 发起者：主牌 ≤3 张、对家副牌 ≥3 张、本队本局未过河（先点先得，服务端裁决）。
// 发起者给对家 3 张（全部主牌 + 副牌补足）；对家回 3 张副牌（30 秒不选自动挑最小 3 副）。

// 过河阶段收尾判定：无候选人且无进行中的过河 → 进入出牌（先做碾压判定，用过河后的手牌）
function maybeFinishCrossRiver(state) {
  if (state.phase !== 'CROSS_RIVER') return;
  const r = state.round;
  if (crossRiverCandidates(state).length > 0) return;
  if (r.crossRiver.active.length > 0) return; // 等对家回牌
  state.phase = 'PLAYING';
  r.playDeadline = null;
  r.playTurnSeat = null;
  const dominance = checkDominance(state);
  if (dominance) {
    r.dominance = dominance;
    state.phase = 'DOMINANCE';
    pushLog(
      state,
      `碾压判定：${TEAM_NAMES[dominance.winningTeam]}将赢下剩余 ${dominance.remainingTricks} 轮，共 ${dominance.remainingPoints} 分` +
        `${dominance.pointsToDefender ? '，计入闲家' : '，庄家跑掉'}${dominance.kittyGrab ? '，闲家撬底' : ''}。`
    );
    return;
  }
  pushLog(state, '进入出牌阶段，由庄家先出牌。');
}

export function handleInitiateCrossRiver(state, action, actorId) {
  if (state.phase !== 'CROSS_RIVER') return fail(ErrorCode.WRONG_PHASE, '当前阶段不能过河');
  const r = state.round;
  const me = playerById(state, actorId);
  // 先点先得：本队已有进行中的过河 → 拒绝（同队两人同时符合时只有先点的成功）。
  // 先于候选判定检查，给出更精确的错误码。
  if (r.crossRiver.active.some(a => a.fromSeat % 2 === me.team)) {
    return fail(ErrorCode.CROSS_RIVER_TEAM_ACTIVE, '同队已有人发起过河（先点先得）');
  }
  if (!crossRiverCandidates(state).includes(me.seat)) {
    return fail(ErrorCode.CROSS_RIVER_NOT_ELIGIBLE, '你不符合过河条件（主牌 >3、对家副牌不足 3 张、本队已过河或已跳过）');
  }
  const giveErr = validateRiverGive(me.hand, action.cardIds, r.trumpSuit, r.rankCard);
  if (giveErr) return fail(ErrorCode.CARDS_NOT_IN_HAND, giveErr);
  const partner = playerBySeat(state, oppositeSeat(me.seat));
  r.crossRiver.active.push({
    fromSeat: me.seat,
    toSeat: partner.seat,
    giveCardIds: [...action.cardIds],
    deadline: Date.now() + (state.timing ? state.timing.crossRiverPickMs : CROSS_RIVER_PICK_MS),
  });
  pushLog(state, `${me.nickname} 发起三主过河，等待 ${partner.nickname} 回 3 张副牌（30 秒不选则自动挑最小 3 副）`);
  return succeed();
}

export function handleRespondCrossRiver(state, action, actorId) {
  if (state.phase !== 'CROSS_RIVER') return fail(ErrorCode.WRONG_PHASE, '当前阶段没有等待回牌的过河');
  const r = state.round;
  const me = playerById(state, actorId);
  const active = r.crossRiver.active.find(a => a.toSeat === me.seat);
  if (!active) return fail(ErrorCode.CROSS_RIVER_NO_WAIT, '没有等待你回牌的过河');
  const backErr = validateRiverBack(me.hand, action.cardIds, r.trumpSuit, r.rankCard);
  if (backErr) return fail(ErrorCode.CARDS_NOT_IN_HAND, backErr);

  const from = playerBySeat(state, active.fromSeat);
  const moves = executeCrossRiver(state, active, action.cardIds);
  relocateTableCards(state, moves); // 件表 + 主牌表同步换手（对对手仍是暗牌）
  assertEqualHandCounts(state.players);
  pushLog(state, `${from.nickname} 与 ${me.nickname} 三主过河（3 张换 3 张）`);
  maybeFinishCrossRiver(state);
  return succeed();
}

export function handleSkipCrossRiver(state, action, actorId) {
  if (state.phase !== 'CROSS_RIVER') return fail(ErrorCode.WRONG_PHASE, '当前阶段不能跳过过河');
  const r = state.round;
  const me = playerById(state, actorId);
  if (!crossRiverCandidates(state).includes(me.seat)) {
    return fail(ErrorCode.CROSS_RIVER_NOT_ELIGIBLE, '你当前无需决定过河');
  }
  if (!r.crossRiver.passedSeats.includes(me.seat)) r.crossRiver.passedSeats.push(me.seat);
  pushLog(state, `${me.nickname} 跳过三主过河`);
  maybeFinishCrossRiver(state);
  return succeed();
}

// 决定窗口结束：仍未行动的候选人全部视为跳过（引擎计时调用）
export function expireCrossRiverDecision(state) {
  if (state.phase !== 'CROSS_RIVER') return;
  const r = state.round;
  for (const seat of crossRiverCandidates(state)) {
    if (!r.crossRiver.passedSeats.includes(seat)) r.crossRiver.passedSeats.push(seat);
  }
  maybeFinishCrossRiver(state);
}

// 对家回牌超时：系统自动挑他最小的 3 张副牌送出，避免卡死（引擎计时调用）
export function autoRespondCrossRiver(state, fromSeat) {
  if (state.phase !== 'CROSS_RIVER') return;
  const r = state.round;
  const active = r.crossRiver.active.find(a => a.fromSeat === fromSeat);
  if (!active) return;
  const partner = playerBySeat(state, active.toSeat);
  const pick = pickLowestSideCards(partner.hand, 3, r.trumpSuit, r.rankCard);
  pushLog(state, `${partner.nickname} 未回牌，系统自动挑出 3 张最小副牌完成过河`);
  const result = handleRespondCrossRiver(state, { cardIds: pick.map(c => c.id) }, partner.id);
  if (!result.ok) {
    pushLog(state, `自动回牌失败：${result.error.reason}`);
  }
}

// ---- 出牌（PLAYING，阶段3）----

export function handlePlay(state, action, actorId) {
  if (state.phase !== 'PLAYING') return fail(ErrorCode.WRONG_PHASE, '当前阶段不能出牌');
  const r = state.round;
  if (r.lastTrick) return fail(ErrorCode.WAIT_SETTLE, '上一轮结算中，请稍等');
  const me = playerById(state, actorId);
  if (me.seat !== r.turnSeat) return fail(ErrorCode.NOT_YOUR_TURN, '还没轮到你出牌');

  const isLead = r.currentTrick.length === 0;
  // 与服务端同一份纯函数校验（前端本地校验仅为 UX）
  const verdict = isLead
    ? validateLeadPlay(
        {
          hand: me.hand,
          piecesView: pieceStatusesFor(r.pieces, r.trumpSuit, me.seat),
          trumpSuit: r.trumpSuit,
          rankCard: r.rankCard,
        },
        action.cardIds
      )
    : validateFollowPlay(
        {
          hand: me.hand,
          leadSuit: r.currentTrick[0].playSuit,
          leadCount: r.currentTrick[0].cards.length,
          trumpSuit: r.trumpSuit,
          rankCard: r.rankCard,
        },
        action.cardIds
      );
  if (!verdict.ok) return fail(verdict.error, verdict.reason);

  // 出牌
  const cards = action.cardIds.map(id => me.hand.find(c => c.id === id));

  // 主牌甩牌（阶段7）：资格由服务端在此裁决，客户端不给提示也不提前拒绝。
  // 算对了 → 整手打出；算错了（有更大的主牌在别人暗牌里）→ 只保留最小一张，
  // 其余收回手中，本轮即以这一张作为首家出牌继续（无额外罚分）。
  let playedCards = cards;
  if (isLead && verdict.kind === 'trumpThrow') {
    const dump = trumpDumpVerdict(
      { trumpCards: r.trumpCards, mySeat: me.seat, trumpSuit: r.trumpSuit, rankCard: r.rankCard },
      cards
    );
    if (!dump.eligible) {
      playedCards = [dump.minCard];
      pushLog(state, `${me.nickname} 甩主牌不成立，只打出最小的一张，其余收回。`);
    }
  }

  // 「妮！」彩蛋：打出 Q（任意花色）时 40% 概率触发（服务端独立随机源掷骰，
  // 四家看到的结果一致；一次出牌含多张 Q 也只掷一次）。
  // 「妮！」彩蛋：只有【单张】Q 才触发。甩牌里夹着 Q 不算 —— 甩牌是一手战术，
  // 不是「打了个 Q」这个动作，弹彩蛋会盖住甩牌本身的注意力。
  const nii =
    playedCards.length === 1 &&
    playedCards[0].rank === 12 &&
    (state.niiRandom ?? Math.random)() < 0.4;
  // ---- 大鬼「压制」判定：「谱掉你」与被压制方彩蛋共用这一道闸 ----
  //
  // 打出大鬼算「压制」要同时满足：
  //   · 不是最后一轮 —— 最后一轮谁出什么都没得选，甩狠话没意思
  //     （四家手牌数恒等，我这一手正好打空就是最后一轮）
  //   · 不是本轮首家 —— 自己领出大鬼没有「压」谁，是自己起的头
  //   · 这张大鬼当下确实赢着这一墩 —— 「被碰出来的」不算：
  //     两张大鬼同强度、先出者大，后出的那张压不过人家，反倒是自己被压
  //
  // 与「妮！」共用同一条独立随机源：绝不能用发牌 rng，否则掷骰会推进 RNG
  // 状态、SEED=42 就复现不出同一副牌（验收用例 §10-52）。
  const isLastTrick = me.hand.length === playedCards.length;
  const trickCtx = { trumpSuit: r.trumpSuit, rankCard: r.rankCard };
  const provisional = { seat: me.seat, cards: playedCards };
  const beatenSeat = r.currentTrick.length > 0
    ? trickLeader(r.currentTrick, trickCtx)?.seat ?? null
    : null;
  const winsNow =
    trickLeader([...r.currentTrick, provisional], trickCtx)?.seat === me.seat;
  // 注：这里不必再写 !isLead —— 首家出牌时 currentTrick 为空，beatenSeat 必然为 null，
  // 「非首家」已经被 beatenSeat !== null 完整覆盖。多写一条恒真的条件既是死代码，
  // 也会让变异测试误以为它被覆盖了（实际上删掉它行为一点不变）。
  const suppresses =
    !isLastTrick &&
    winsNow &&
    beatenSeat !== null &&
    beatenSeat !== me.seat &&
    playedCards.some(c => c.rank === 16);

  const pudiao = suppresses && (state.niiRandom ?? Math.random)() < 0.8;
  // 被压制的那家（通常是上家）自己回一句 —— 与「谱掉你」各掷各的骰，
  // 「谱掉你」没弹出来也照样可能回嘴。
  const beatenEgg = suppresses
    ? rollSuppressedEgg(state.niiRandom ?? Math.random)
    : null;

  me.hand = me.hand.filter(c => !playedCards.some(p => p.id === c.id));
  const play = { seat: me.seat, cards: playedCards };
  if (isLead) play.playSuit = verdict.playSuit;
  if (nii) play.nii = true;
  if (pudiao) play.pudiao = true;
  r.currentTrick.push(play);
  if (beatenEgg) {
    // 挂在【被压制那家】已经出过的牌上，不是打大鬼这家
    const victim = r.currentTrick.find(p => p.seat === beatenSeat);
    if (victim) victim.beatenEgg = beatenEgg;
  }

  if (r.currentTrick.length < 4) {
    r.turnSeat = nextSeat(me.seat);
    return succeed();
  }

  // 四家出齐 → 结算
  const ctx = { trumpSuit: r.trumpSuit, rankCard: r.rankCard };
  const result = resolveTrick(r.currentTrick, ctx);
  const trickResult = {
    trickNo: r.trickHistory.length + 1,
    leadSeat: r.currentTrick[0].seat,
    leadSuit: r.currentTrick[0].playSuit, // 领出花色（TRUMP 或副牌花色），供“吊主”等展示判定
    leadType: r.currentTrick[0].cards.length === 1 ? 'single' : 'throw',
    plays: r.currentTrick,
    winnerSeat: result.winnerSeat,
    points: result.points,
  };
  r.trickHistory.push(trickResult);
  r.lastTrick = trickResult; // 停留展示，由引擎计时 1.5 秒后清空
  r.currentTrick = [];
  r.leadSeat = result.winnerSeat;
  r.turnSeat = result.winnerSeat;
  r.settleDeadline = Date.now() + (state.timing ? state.timing.settleMs : 1500);

  // 分数分账：赢家是闲家方 → 计入闲家；赢家是庄家方 → 作废跑掉（庄家不吃分）
  const declarerTeam = state.declarerSeat % 2;
  const winner = playerBySeat(state, result.winnerSeat);
  if (winner.team === declarerTeam) {
    r.runAwayPoints += result.points;
  } else {
    r.defenderTrickPoints += result.points;
  }

  // 件状态迁移：一轮结束后统一迁移（不在单张出牌时迁移）；主牌去向表同步迁移
  migratePlayedPieces(r.pieces, trickResult);
  migratePlayedPieces(r.trumpCards, trickResult);

  // 不变量：四家手牌数相等（跟牌张数校验的兜底）
  assertEqualHandCounts(state.players);

  pushLog(
    state,
    `${winner.nickname} 赢得本轮${
      result.points > 0
        ? `，${result.points} 分${winner.team === declarerTeam ? '作废' : '计入闲家'}`
        : ''
    }`
  );

  if (state.players.every(p => p.hand.length === 0)) {
    // 局末结算：底牌计分、撬底、升级移庄、庄家轮转、胜负判定
    finishRound(state);
    return succeed();
  }
  // 每轮结算后检测碾压（充分条件，宁可漏检不误判）
  const dominance = checkDominance(state);
  if (dominance) {
    r.dominance = dominance;
    state.phase = 'DOMINANCE';
    pushLog(
      state,
      `碾压判定：${TEAM_NAMES[dominance.winningTeam]}将赢下剩余 ${dominance.remainingTricks} 轮，共 ${dominance.remainingPoints} 分` +
        `${dominance.pointsToDefender ? '，计入闲家' : '，庄家跑掉'}${dominance.kittyGrab ? '，闲家撬底' : ''}。`
    );
  }
  return succeed();
}

// ---- 碾压收尾确认（DOMINANCE）----

export function handleConfirmDominance(state, action, actorId) {
  if (state.phase !== 'DOMINANCE') return fail(ErrorCode.WRONG_PHASE, '当前阶段无需确认');
  const r = state.round;
  const dom = r.dominance;
  if (!dom) return fail(ErrorCode.WRONG_PHASE, '无碾压判定');

  // 剩余所有轮次的分数全部判给占优方：
  // A 是闲家方 → 计入 defenderTrickPoints；A 是庄家方 → 作废进 runAwayPoints。
  if (dom.pointsToDefender) {
    r.defenderTrickPoints += dom.remainingPoints;
  } else {
    r.runAwayPoints += dom.remainingPoints;
  }
  // 关键：最后一轮赢家记为 A 队（撬底据此判定），随后 settleRound 公式不变。
  const winnerSeat = r.leadSeat; // A 队成员
  const virtualTrick = {
    trickNo: r.trickHistory.length + 1,
    leadSeat: r.leadSeat,
    leadType: 'single',
    plays: [],
    winnerSeat,
    points: dom.remainingPoints,
    virtual: true,
  };
  r.trickHistory.push(virtualTrick);
  r.lastTrick = virtualTrick;
  r.currentTrick = [];
  for (const p of state.players) p.hand = [];
  finishRound(state);
  return succeed();
}

// ---- 本局小结确认（ROUND_END）----
// 小结停留 100 秒，给四个人复盘。谁看完了点一下；四个人都点完就提前进入下一局。
// 不强制 —— 没点满就等满 100 秒，掉线的人不会把全场卡住。

export function handleConfirmRoundEnd(state, action, actorId) {
  if (state.phase !== 'ROUND_END') return fail(ErrorCode.WRONG_PHASE, '当前阶段无需确认小结');
  const r = state.round;
  if (!r) return fail(ErrorCode.WRONG_PHASE, '本局小结已结束');
  const me = playerById(state, actorId);
  if (r.roundEndConfirms.includes(me.seat)) {
    return fail(ErrorCode.ALREADY_VOTED, '你已经确认过了');
  }
  r.roundEndConfirms.push(me.seat);
  pushLog(state, `${me.nickname} 看完本局小结（${r.roundEndConfirms.length}/4）`);
  if (r.roundEndConfirms.length >= PLAYER_COUNT) {
    pushLog(state, '四人都已看完小结，提前进入下一局。');
    advanceToReadyCheck(state);
  }
  return succeed();
}

// ---- 新开一局（提案制：四人全同意才执行；任一人拒绝立即取消；60 秒超时取消）----

function executeReset(state, { reshuffleSeats, forced, actorName }) {
  resetGameState(state, { reshuffleSeats });
  state.resetProposal = null;
  state.saveClearRequested = true;
  pushLog(
    state,
    forced
      ? `⛔ ${actorName} 执行了强制重置（跳过全员同意）。`
      : state.phase === 'SEATING'
        ? '四人全部同意，新开一局：座位已重新随机。'
        : '四人全部同意，新开一局：座位保留，全员准备后开始。'
  );
}

export function handleProposeReset(state, action, actorId) {
  if (state.resetProposal) return fail(ErrorCode.PROPOSAL_ACTIVE, '已有新开一局提案进行中');
  const me = playerById(state, actorId);
  state.resetProposal = {
    fromSeat: me.seat,
    yesSeats: [me.seat], // 发起者视为已同意
    reshuffleSeats: action.reshuffleSeats === true,
    deadline: Date.now() + (state.timing ? state.timing.resetProposalMs : 60000),
  };
  pushLog(state, `${me.nickname} 提议新开一局（${state.resetProposal.reshuffleSeats ? '重新随机座位' : '保留座位'}），等待全员同意（1/4）。`);
  return succeed();
}

export function handleVoteReset(state, action, actorId) {
  if (!state.resetProposal) return fail(ErrorCode.WRONG_PHASE, '当前没有新开一局提案');
  const me = playerById(state, actorId);
  const p = state.resetProposal;
  if (me.seat === p.fromSeat) return fail(ErrorCode.ALREADY_VOTED, '你是发起者，无需投票');
  if (p.yesSeats.includes(me.seat)) return fail(ErrorCode.ALREADY_VOTED, '你已经投过票');

  if (action.agree === false) {
    // 任一人拒绝 → 立即取消
    state.resetProposal = null;
    pushLog(state, `${me.nickname} 拒绝了新开一局，提案取消。`);
    return succeed();
  }
  p.yesSeats.push(me.seat);
  if (p.yesSeats.length === 4) {
    executeReset(state, { reshuffleSeats: p.reshuffleSeats, forced: false, actorName: me.nickname });
  } else {
    pushLog(state, `${me.nickname} 同意新开一局（${p.yesSeats.length}/4）。`);
  }
  return succeed();
}

// 60 秒无人响应 → 自动取消（引擎计时调用）
export function expireResetProposal(state) {
  if (!state.resetProposal) return;
  state.resetProposal = null;
  pushLog(state, '新开一局提案超时，自动取消。');
}

// 管理员强制重置：跳过全员同意，但必须持有 ADMIN_RESET_TOKEN（连接时校验）
export function handleForceReset(state, action, actorId) {
  if (!state.adminIds.includes(actorId)) {
    return fail(ErrorCode.FORBIDDEN, '需要管理员权限（?RESET=口令）');
  }
  const me = playerById(state, actorId);
  const reshuffle = action.reshuffleSeats === true;
  const hadProposal = !!state.resetProposal;
  state.resetProposal = null;
  executeReset(state, { reshuffleSeats: reshuffle, forced: true, actorName: me.nickname });
  if (hadProposal) pushLog(state, '（原提案被强制重置取代）');
  return succeed();
}

// ---- 聊天（任意阶段可用）----

export function handleChat(state, action, actorId) {
  const me = playerById(state, actorId);
  const text = String(action.text ?? '').trim().slice(0, 200);
  if (!text) return fail(ErrorCode.CHAT_INVALID, '消息不能为空');
  state.chat.push({ kind: 'CHAT', from: actorId, text, ts: Date.now() });
  if (state.chat.length > 300) state.chat.splice(0, 100);
  return succeed();
}

export function handleQuickChat(state, action, actorId) {
  const phrase = QUICK_PHRASES[action.phraseId];
  if (!phrase) return fail(ErrorCode.CHAT_INVALID, '未知快捷短语');
  return handleChat(state, { text: phrase }, actorId);
}

// ---- 阶段转换检查：每个动作完成后调用 ----

function checkTransitions(state) {
  if (state.phase === 'SEATING') {
    const allLocked = state.players.every(p => p.connected && p.seatLocked);
    if (allLocked) {
      state.phase = 'READY_CHECK';
      pushLog(state, '座位已锁定，等待全员准备。');
    }
  }
}

const HANDLERS = {
  join: handleJoin,
  leave: handleLeave,
  addBot: handleAddBot,
  removeBot: handleRemoveBot,
  proposeSwap: handleProposeSwap,
  acceptSwap: handleAcceptSwap,
  declineSwap: handleDeclineSwap,
  confirmSeat: handleConfirmSeat,
  ready: handleReady,
  claimFlipper: handleClaimFlipper,
  drawCard: handleDrawCard,
  declareTrump: handleDeclareTrump,
  buryKitty: handleBuryKitty,
  initiateCrossRiver: handleInitiateCrossRiver,
  respondCrossRiver: handleRespondCrossRiver,
  skipCrossRiver: handleSkipCrossRiver,
  play: handlePlay,
  confirmDominance: handleConfirmDominance,
  confirmRoundEnd: handleConfirmRoundEnd,
  confirmFlip: handleConfirmFlip,
  pause: handlePause,
  resume: handleResume,
  proposeReset: handleProposeReset,
  voteReset: handleVoteReset,
  forceReset: handleForceReset,
  chat: handleChat,
  quickChat: handleQuickChat,
};

// 与阶段无关的动作：陈旧状态检查豁免（聊天/登录/重置提案随时可用）
const PHASE_AGNOSTIC = new Set([
  'join', 'leave', 'chat', 'quickChat', 'pause', 'resume',
  'proposeReset', 'voteReset', 'forceReset',
]);

// 暂停期间仍然放行的动作：进出房间、聊天，以及恢复本身。
// 其余一律拒绝 —— 暂停要是还能出牌，那就不叫暂停了。
const ALLOWED_WHILE_PAUSED = new Set(['join', 'leave', 'chat', 'quickChat', 'pause', 'resume']);

// 服务端权威裁决入口：所有客户端意图必须经过这里；
// 前端本地校验只为 UX，不是防线。
export function applyAction(state, action, actorId) {
  const handler = HANDLERS[action && action.type];
  if (!handler) return fail(ErrorCode.BAD_ACTION, '未知动作');
  // 抢亮主是四个人同时按的动作，必须先于下面的陈旧状态防护处理：
  // 先按到的人一成功，phase 立刻变成 DEALING，晚到的那几个就再也走不到
  // handleDeclareTrump 里的 TRUMP_ALREADY_DECLARED 分支，只会拿到笼统的
  // 「界面状态已更新，请重试」——可主牌已经定死、不能反主，重试毫无意义，
  // 而且把一个正常的规则事件说得像故障。这里给出准确原因。
  if (action?.type === 'declareTrump' && state.round?.trumpSuit) {
    return fail(ErrorCode.TRUMP_ALREADY_DECLARED, '已有人先亮主');
  }
  // 暂停闸门放在所有规则判定之前：暂停期间不接受任何推进牌局的动作
  if (state.paused && !ALLOWED_WHILE_PAUSED.has(action?.type)) {
    return fail(ErrorCode.PAUSED, '游戏已暂停，恢复后才能继续');
  }
  // 陈旧状态防护：客户端带上已知 phase，不一致说明点的是过期界面，
  // 返回明确的 STALE_STATE 而不是笼统的错误。
  if (
    action &&
    !PHASE_AGNOSTIC.has(action.type) &&
    action.phase !== undefined &&
    action.phase !== state.phase
  ) {
    return fail(
      ErrorCode.STALE_STATE,
      `界面状态已更新（${action.phase} → ${state.phase}），操作未生效，请重试`
    );
  }
  const result = handler(state, action, actorId);
  if (result.ok) checkTransitions(state);
  return result;
}
