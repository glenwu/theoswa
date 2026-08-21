import { PLAYERS } from './constants.js';
import {
  REVEAL_FLIP_MS,
  REVEAL_DRAW_MS,
  REVEAL_GRACE_MS,
  FALLBACK_REVEAL_MS,
  DEALING_MS,
  TRICK_SETTLE_MS,
  SCORING_MS,
  ROUND_END_MS,
  PLAY_TIMEOUT_MS,
  RESET_PROPOSAL_MS,
  CROSS_RIVER_DECIDE_MS,
  CROSS_RIVER_PICK_MS,
  AUTO_LAST_MS,
} from './constants.js';

function finiteNumber(value, fallback, min = -Infinity, max = Infinity) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function normalizedPlayerLearning(profile = {}) {
  return {
    reviewedPlays: Math.floor(finiteNumber(profile.reviewedPlays, 0, 0)),
    pieceCaution: finiteNumber(profile.pieceCaution, 1, 1, 3),
    pointCaution: finiteNumber(profile.pointCaution, 1, 1, 3),
    overplayCaution: finiteNumber(profile.overplayCaution, 1, 1, 3),
    coverCaution: finiteNumber(profile.coverCaution, 1, 1, 3),
    controlCaution: finiteNumber(profile.controlCaution, 1, 1, 3),
  };
}

// 电脑学习档案的持久化迁移。旧版是 { playerId: profile }，新版拆成
// shared（所有电脑共享的经验）和 players（个人微调），恢复旧存档时自动兼容。
export function normalizeBotLearning(value) {
  const source = value && typeof value === 'object' ? value : {};
  const sharedSource = source.shared && typeof source.shared === 'object' ? source.shared : {};
  const legacyPlayers = Object.fromEntries(
    Object.entries(source).filter(([key, profile]) =>
      key !== 'shared' && key !== 'players' && profile && typeof profile === 'object'
    )
  );
  const explicitPlayers = source.players && typeof source.players === 'object'
    ? source.players
    : {};
  const players = {};
  for (const [playerId, profile] of Object.entries({ ...legacyPlayers, ...explicitPlayers })) {
    players[playerId] = normalizedPlayerLearning(profile);
  }

  return {
    shared: {
      roundsReviewed: Math.floor(finiteNumber(sharedSource.roundsReviewed, 0, 0)),
      playsReviewed: Math.floor(finiteNumber(sharedSource.playsReviewed, 0, 0)),
      pieceCaution: finiteNumber(sharedSource.pieceCaution, 1, 1, 3),
      pointCaution: finiteNumber(sharedSource.pointCaution, 1, 1, 3),
      overplayCaution: finiteNumber(sharedSource.overplayCaution, 1, 1, 3),
      coverCaution: finiteNumber(sharedSource.coverCaution, 1, 1, 3),
      controlCaution: finiteNumber(sharedSource.controlCaution, 1, 1, 3),
      dealerBottomWeight: finiteNumber(sharedSource.dealerBottomWeight, 1, 1, 2.5),
      defenderBottomWeight: finiteNumber(sharedSource.defenderBottomWeight, 1, 1, 2.5),
      dealerRounds: Math.floor(finiteNumber(sharedSource.dealerRounds, 0, 0)),
      dealerBottomSaved: Math.floor(finiteNumber(sharedSource.dealerBottomSaved, 0, 0)),
      defenderRounds: Math.floor(finiteNumber(sharedSource.defenderRounds, 0, 0)),
      defenderBottomGrabbed: Math.floor(finiteNumber(sharedSource.defenderBottomGrabbed, 0, 0)),
    },
    players,
  };
}

// 洗牌（可注入 rng 便于测试）
export function shuffleArray(arr, rng = Math.random) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// 创建游戏初始状态：座位全局随机一次，之后各局固定
export function createInitialState(rng = Math.random) {
  const seats = shuffleArray([0, 1, 2, 3], rng);
  const seatsByPlayer = {};
  PLAYERS.forEach((p, i) => { seatsByPlayer[p.id] = seats[i]; });

  return {
    phase: 'SEATING',
    seatsByPlayer,
    teamLevels: [0, 0], // [team0, team1] 的 levelIndex；级别只记在队伍上，不记在个人上
    players: PLAYERS.map(p => ({
      id: p.id,
      nickname: p.nickname,
      seat: seatsByPlayer[p.id],
      team: seatsByPlayer[p.id] % 2,
      ready: false,
      seatLocked: false,
      connected: false,
      isBot: false,
      hand: [], // 服务端全量持有；广播时按玩家裁剪
    })),
    declarerSeat: null, // Seat | null；只有亮牌成功或轮转产生新庄家时才被赋值
    flipperSeat: null,  // REVEAL_FIRST 抢按揭牌人
    swapProposals: [],  // { fromSeat, toSeat }[]
    round: null,        // RoundState；第一局开始前为 null
    rounds: [],         // 已完成的每局摘要（RoundSummary，本局历史）
    // 新开一局提案（服务端状态：全员可见、可存档、可超时）：
    // { fromSeat, yesSeats: [seat...], reshuffleSeats, deadline }
    resetProposal: null,
    // 管理员身份（连接时凭 ADMIN_TOKEN 授予；用于强制重置）
    adminIds: [],
    log: [],            // 系统播报（全员公开）
    chat: [],           // 玩家聊天
    gameWinnerTeam: null,
    // 电脑局末复盘累积的共享/个人参数；只来自历史已完成决策，不包含任何隐藏手牌。
    botLearning: normalizeBotLearning(),
    // 请求清档标记（新开一局执行后由网络层消费）
    saveClearRequested: false,
    // 洗牌随机源（测试注入种子；不对外广播）
    rng: rng ?? Math.random,
    // 「妮！」彩蛋独立随机源：绝不用发牌种子流，否则每次掷骰都推进 RNG 状态、
    // SEED=42 就无法复现同一副牌。函数不持久化（JSON 丢弃），恢复时 normalizeState 补回。
    niiRandom: Math.random,
    // 阶段节奏（毫秒；GameEngine 可用环境变量覆盖）
    timing: {
      flipMs: REVEAL_FLIP_MS,
      drawMs: REVEAL_DRAW_MS,
      graceMs: REVEAL_GRACE_MS,
      fallbackMs: FALLBACK_REVEAL_MS,
      dealingMs: DEALING_MS,
      settleMs: TRICK_SETTLE_MS,
      scoringMs: SCORING_MS,
      roundEndMs: ROUND_END_MS,
      playMs: PLAY_TIMEOUT_MS,
      resetProposalMs: RESET_PROPOSAL_MS,
      crossRiverDecideMs: CROSS_RIVER_DECIDE_MS,
      crossRiverPickMs: CROSS_RIVER_PICK_MS,
      autoLastMs: AUTO_LAST_MS,
    },
  };
}

// 每局重建的轮局状态
export function createRoundState(roundNumber, declarerSeat) {
  return {
    roundNumber,        // 流局不递增；ROUND_END 后才 +1（阶段4）
    declarerSeat,       // Seat | null：第一局揭牌前为 null
    trumpSuit: null,
    rankCard: 2,        // 由庄家方级别换算（beginRound 时填入）
    deck: [],           // 待揭的 100 张（REVEAL_FIRST 翻牌期间为完整 108 张）
    kitty: [],          // 8 张底牌，洗牌后立即分离；局末前对非庄家不可见
    kittyPoints: 0,
    flipDone: false,    // REVEAL_FIRST：翻牌定起揭人是否完成
    flipShown: [],      // REVEAL_FIRST：本次翻出的牌（公开，含作废的大小王）
    revealTurnSeat: null,   // 当前该谁揭牌
    drawnCount: 0,          // 已揭张数 0..100
    drawDeadline: null,     // 本次揭牌超时时刻（超时服务端自动摸）
    graceDeadline: null,    // 100张摸完后的亮主宽限窗口截止时刻
    fallbackSuit: null,     // 揭底定主：首张非王牌的花色
    fallbackRevealed: [],   // 揭底定主：已公开摊开的底牌
    leadSeat: null,
    turnSeat: null,
    playDeadline: null,     // 出牌限时截止时刻（超时服务端自动出最小合法牌）
    playTurnSeat: null,     // 出牌限时对应的当前回合座位（换人时重置）
    currentTrick: [],
    lastTrick: null,
    settleDeadline: null,   // 收牌停留截止时刻（服务端计时，四端同步）
    trickHistory: [],
    dominance: null,        // 碾压判定（充分条件命中后填入，DOMINANCE 阶段展示）
    roundEndConfirms: [],   // 本局小结已点「看完了」的座位；集齐 4 个提前进入下一局
    roundEndDeadline: null, // 小结停留截止时刻（服务端计时，四端同步倒计时）
    defenderTrickPoints: 0, // 闲家台面抓分（纯牌面分，守恒校验用）
    runAwayPoints: 0,       // 庄家赢下、作废跑掉的分
    defenderPoints: null,   // 局末最终 P（含撬底加成），SCORING 时填入
    pieces: [],             // 件追踪（换底完成后重建）
    // 阶段7：
    trumpCards: [],         // 全主牌去向表（与件表同构）：主牌甩牌资格判定的唯一依据
    crossRiver: {           // 三主过河（KITTY_EXCHANGE → CROSS_RIVER → PLAYING）
      doneTeams: [],        //   已过河的队伍（每队每局最多一次）
      passedSeats: [],      //   明确跳过的玩家（不再弹候选）
      active: [],           //   进行中的过河 [{ fromSeat, toSeat, giveCardIds, deadline }]
      decideDeadline: null, //   发起/跳过决定窗口截止时刻（到时未行动的候选人自动跳过）
    },
    declarerCrossedRiver: false, // 庄家本局是否触发过三主过河（被撬底时按底牌主牌数额外加级）
    // 关键节点大图数据（客户端中央牌桌展示用，均为公开信息）：
    flipEvent: null,        // 翻牌定起揭人：最近一次翻牌 { kind: 'JOKER'|'STARTER', card, starterSeat?, ts }
    trumpEvent: null,       // 亮主：{ card, declarerSeat, wasFirstRound, ts }
    fallbackTrumpCard: null,// 揭底定主：定主的那张底牌
  };
}

// 新开一局 / 再来一局：级别、局数、庄家全部重置；座位默认保留（可选重新随机）。
export function resetGameState(state, { reshuffleSeats = false } = {}) {
  if (reshuffleSeats) {
    const seats = shuffleArray([0, 1, 2, 3], state.rng ?? Math.random);
    const seatsByPlayer = {};
    PLAYERS.forEach((p, i) => { seatsByPlayer[p.id] = seats[i]; });
    state.seatsByPlayer = seatsByPlayer;
    for (const p of state.players) {
      p.seat = seatsByPlayer[p.id];
      p.team = p.seat % 2;
      p.seatLocked = false;
    }
    state.phase = 'SEATING'; // 重新随机 → 允许再次换座确认
  } else {
    for (const p of state.players) p.seatLocked = true; // 座位保留 → 直接准备
    state.phase = 'READY_CHECK';
  }
  for (const p of state.players) {
    p.ready = false;
    p.hand = [];
  }
  state.teamLevels = [0, 0];
  state.declarerSeat = null;
  state.flipperSeat = null;
  state.swapProposals = [];
  state.round = null;
  state.rounds = [];
  state.gameWinnerTeam = null;
  state.log = [];
  state.chat = [];
  return state;
}

// 存档迁移：旧版本存档缺少新字段时按默认值补齐（不重洗座位、不动对局进度）。
// players/teamLevels 形状明显损坏（不是 4 人数组）返回 null，由调用方视为无存档。
// ⚠️ 每次给 GameState 新增顶层字段，必须在这里补默认值，否则旧存档恢复后必崩。
export function normalizeState(state) {
  if (!state || typeof state !== 'object') return null;
  if (!Array.isArray(state.players) || state.players.length !== 4) return null;
  if (!Array.isArray(state.teamLevels)) return null;
  const defaults = {
    swapProposals: [],
    rounds: [],
    resetProposal: null,
    adminIds: [],
    log: [],
    chat: [],
    saveClearRequested: false,
    botLearning: {},
    niiRandom: Math.random, // 彩蛋随机源不持久化，恢复时用独立随机源
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (state[key] === undefined) state[key] = value;
  }
  for (const player of state.players) {
    player.isBot = player.isBot === true;
  }
  state.botLearning = normalizeBotLearning(state.botLearning);
  return state;
}

export function playerById(state, id) {
  return state.players.find(p => p.id === id) ?? null;
}

export function playerBySeat(state, seat) {
  return state.players.find(p => p.seat === seat) ?? null;
}

export function pushLog(state, text) {
  state.log.push({ kind: 'SYSTEM', text, ts: Date.now() });
  if (state.log.length > 500) state.log.splice(0, 200);
}
