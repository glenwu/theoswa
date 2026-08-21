import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, normalizeState } from '../state.js';
import { applyAction, ErrorCode } from '../actions.js';
import { PHASES } from '../constants.js';
import { viewerState } from '../viewer.js';
import {
  assessBottomProtection,
  BOT_TUNING_BOUNDS,
  decideBotAction,
  evaluateFollowChoices,
  normalizeBotTuning,
  normalizeBotDifficulty,
  chooseFollowCards,
  chooseKittyCards,
  chooseLeadCards,
  chooseTrumpDeclaration,
} from '../bot-policy.js';
import { inferPublicBeliefs } from '../bot-belief.js';
import { BotController, botDelayForDecision } from '../bot-controller.js';
import { BotReviewJournal, botLearningProfile, inspectBotPlay } from '../bot-review.js';
import { GameEngine } from '../game-engine.js';
import { mulberry32 } from '../rng.js';
import { serializeState } from '../persist.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const card = (id, suit, rank) => ({ id, suit, rank });

function playView({
  seat = 2,
  hand = [],
  currentTrick = [],
  trickHistory = [],
  piecesView = { S: [], H: [], D: [], C: [] },
  declarerSeat = 0,
} = {}) {
  return {
    phase: 'PLAYING',
    declarerSeat,
    you: {
      id: 'BOT',
      nickname: '电脑',
      seat,
      team: seat % 2,
      hand,
      crossRiver: {},
    },
    round: {
      roundNumber: 1,
      trumpSuit: 'H',
      rankCard: 2,
      currentTrick,
      trickHistory,
      piecesView,
      lastTrick: null,
      turnSeat: seat,
    },
  };
}

test('大厅可以添加和移除电脑，电脑占用的身份不能被真人登录', () => {
  const state = createInitialState(() => 0.42);
  assert.equal(applyAction(state, { type: 'join' }, 'T').ok, true);

  assert.equal(applyAction(state, { type: 'addBot', playerId: 'H' }, 'T').ok, true);
  const bot = state.players.find(player => player.id === 'H');
  assert.equal(bot.isBot, true);
  assert.equal(bot.connected, true);
  assert.equal(viewerState(state, 'T').players.find(player => player.id === 'H').isBot, true);

  const join = applyAction(state, { type: 'join' }, 'H');
  assert.equal(join.error.code, ErrorCode.BOT_UNAVAILABLE);

  assert.equal(applyAction(state, { type: 'removeBot', playerId: 'H' }, 'T').ok, true);
  assert.equal(bot.isBot, false);
  assert.equal(bot.connected, false);
  assert.equal(applyAction(state, { type: 'join' }, 'H').ok, true);
});

test('电脑只能由在线真人在开局前管理', () => {
  const state = createInitialState(() => 0.42);
  const offline = applyAction(state, { type: 'addBot', playerId: 'H' }, 'T');
  assert.equal(offline.error.code, ErrorCode.FORBIDDEN);

  applyAction(state, { type: 'join' }, 'T');
  state.phase = 'PLAYING';
  const late = applyAction(state, { type: 'addBot', playerId: 'H' }, 'T');
  assert.equal(late.error.code, ErrorCode.WRONG_PHASE);
});

test('电脑身份可持久化，旧存档中缺少标记时默认为真人', () => {
  const state = createInitialState(() => 0.42);
  state.players.find(player => player.id === 'H').isBot = true;
  const restored = normalizeState(JSON.parse(serializeState(state)).game);
  assert.equal(restored.players.find(player => player.id === 'H').isBot, true);

  delete restored.players.find(player => player.id === 'B').isBot;
  normalizeState(restored);
  assert.equal(restored.players.find(player => player.id === 'B').isBot, false);
});

test('旧版单人学习档案恢复后自动迁移为共享学习格式', () => {
  const state = createInitialState(() => 0.42);
  state.botLearning = {
    H: { reviewedPlays: 7, pieceCaution: 1.4, pointCaution: 1.2, overplayCaution: 1.1 },
  };
  normalizeState(state);
  assert.equal(state.botLearning.players.H.reviewedPlays, 7);
  assert.equal(state.botLearning.players.H.pieceCaution, 1.4);
  assert.equal(state.botLearning.shared.roundsReviewed, 0);
});

test('换底策略优先保留主牌和分牌', () => {
  const ctx = { trumpSuit: 'H', rankCard: 2 };
  const safeRanks = [3, 4, 6, 7, 8, 9, 11, 12];
  const hand = [
    ...safeRanks.map((rank, index) => ({ id: `safe-${index}`, suit: 'S', rank })),
    { id: 'five', suit: 'C', rank: 5 },
    { id: 'ten', suit: 'D', rank: 10 },
    { id: 'king', suit: 'C', rank: 13 },
    { id: 'ace', suit: 'D', rank: 14 },
    { id: 'trump', suit: 'H', rank: 3 },
    { id: 'rank-card', suit: 'S', rank: 2 },
  ];
  const chosen = chooseKittyCards(hand, ctx);
  assert.deepEqual(chosen.map(card => card.id).sort(), safeRanks.map((_, i) => `safe-${i}`).sort());
});

test('换底综合主长与控制：双大鬼但主短不埋分，主长时可藏分但保留 AKK 件', () => {
  const ctx = { trumpSuit: 'H', rankCard: 2 };
  const points = [
    card('point-s5', 'S', 5),
    card('point-s10', 'S', 10),
    card('point-c5', 'C', 5),
    card('point-c10', 'C', 10),
    card('point-c-k', 'C', 13),
    card('point-d10', 'D', 10),
    card('point-dk', 'D', 13),
    card('point-d5', 'D', 5),
  ];
  const shortTrumpHand = [
    card('big-1', 'JOKER', 16),
    card('big-2', 'JOKER', 16),
    ...points,
    ...[3, 4, 6, 7, 8, 9, 11, 12].map(rank => card(`low-${rank}`, 'S', rank)),
  ];
  assert.equal(assessBottomProtection(shortTrumpHand, ctx).trumpCount, 2);
  assert.ok(assessBottomProtection(shortTrumpHand, ctx).confidence < 0.2);
  const shortChoice = chooseKittyCards(shortTrumpHand, ctx);
  assert.equal(shortChoice.reduce((sum, item) => sum + (item.rank === 5 || item.rank === 10 || item.rank === 13 ? 1 : 0), 0), 0);

  const longTrumpHand = [
    card('long-big-1', 'JOKER', 16),
    card('long-big-2', 'JOKER', 16),
    card('long-small', 'JOKER', 15),
    card('long-main-rank', 'H', 2),
    card('long-side-rank', 'S', 2),
    ...[3, 4, 6, 7].map(rank => card(`long-trump-${rank}`, 'H', rank)),
    card('throw-a', 'S', 14),
    card('throw-k-1', 'S', 13),
    card('throw-k-2', 'S', 13),
    ...[8, 9, 11, 12].map(rank => card(`throw-support-${rank}`, 'S', rank)),
    card('hide-c5', 'C', 5),
    card('hide-c10', 'C', 10),
    card('hide-d5', 'D', 5),
    card('hide-d10', 'D', 10),
    ...[3, 4, 6, 7, 8, 9, 11, 12].map(rank => card(`filler-c-${rank}`, 'C', rank)),
    ...[3, 4, 6, 7, 8].map(rank => card(`filler-d-${rank}`, 'D', rank)),
  ];
  const protection = assessBottomProtection(longTrumpHand, ctx);
  assert.equal(protection.trumpCount, 9);
  assert.ok(protection.confidence > 0.8);
  const longChoice = chooseKittyCards(longTrumpHand, ctx);
  assert.ok(longChoice.some(item => item.id.startsWith('hide-')), '主长且控制足时可考虑藏分');
  assert.ok(
    ['throw-a', 'throw-k-1', 'throw-k-2'].every(id => !longChoice.some(item => item.id === id)),
    'AKK 是有用的成件结构，不应为埋 10 分拆掉'
  );
  assert.ok(longChoice.every(item => item.rank < 15), '大小鬼不能埋掉');
});

test('现牌策略：第一局摸到级牌立即现，后续局弱花色等待、强花色或最后机会才现', () => {
  const makeView = ({ declarerSeat, hand, drawnCount, difficulty = 'expert' }) => ({
    phase: 'REVEALING',
    declarerSeat,
    botDifficulty: difficulty,
    you: { seat: 2, team: 0, hand },
    round: { rankCard: 6, drawnCount, trumpSuit: null },
  });
  const weakHand = [
    card('heart-6', 'H', 6),
    card('spade-3', 'S', 3),
    card('club-4', 'C', 4),
  ];
  assert.equal(
    chooseTrumpDeclaration(makeView({ declarerSeat: null, hand: weakHand, drawnCount: 8 }))?.id,
    'heart-6',
    '第一局现牌能做庄，弱花色也应立即抢庄'
  );
  assert.equal(
    chooseTrumpDeclaration(makeView({ declarerSeat: 0, hand: weakHand, drawnCount: 20 })),
    null,
    '后续局只有一张红桃级牌且红桃很短时应等待'
  );

  const strongHeart = [
    card('strong-heart-6', 'H', 6),
    card('strong-heart-3', 'H', 3),
    card('strong-heart-4', 'H', 4),
    card('strong-heart-7', 'H', 7),
    card('strong-heart-q', 'H', 12),
    card('strong-heart-a', 'H', 14),
    card('strong-small-joker', 'JOKER', 15),
  ];
  assert.equal(
    chooseTrumpDeclaration(makeView({ declarerSeat: 0, hand: strongHeart, drawnCount: 36 }))?.id,
    'strong-heart-6',
    '红桃数量和控制足够时应主动现红桃'
  );
  assert.equal(
    chooseTrumpDeclaration(makeView({ declarerSeat: 0, hand: weakHand, drawnCount: 96 }))?.id,
    'heart-6',
    '接近揭牌结束时应降低等待门槛'
  );
  assert.equal(
    chooseTrumpDeclaration(makeView({ declarerSeat: 0, hand: weakHand, drawnCount: 20, difficulty: 'easy' }))?.id,
    'heart-6',
    '简单档保留摸到就现的行为'
  );
});

test('公开牌势快照保留8张底牌槽位，并在三门副牌均断后确认全主', () => {
  const view = playView({
    seat: 2,
    declarerSeat: 0,
    hand: [card('mine-heart-3', 'H', 3), card('mine-club-3', 'C', 3)],
    trickHistory: [
      {
        leadSuit: 'S',
        plays: [
          { seat: 0, playSuit: 'S', cards: [card('lead-s', 'S', 3)] },
          { seat: 1, cards: [card('cut-s', 'H', 4)] },
        ],
      },
      {
        leadSuit: 'D',
        plays: [
          { seat: 0, playSuit: 'D', cards: [card('lead-d', 'D', 3)] },
          { seat: 1, cards: [card('cut-d', 'H', 6)] },
        ],
      },
      {
        leadSuit: 'C',
        plays: [
          { seat: 0, playSuit: 'C', cards: [card('lead-c', 'C', 3)] },
          { seat: 1, cards: [card('cut-c', 'H', 7)] },
        ],
      },
    ],
  });
  view.players = [
    { seat: 0, team: 0, handCount: 20 },
    { seat: 1, team: 1, handCount: 20 },
    { seat: 2, team: 0, handCount: 20 },
    { seat: 3, team: 1, handCount: 20 },
  ];
  view.round.kittyCount = 8;
  const beliefs = inferPublicBeliefs(view);
  assert.equal(beliefs.kittySlots, 8);
  assert.equal(beliefs.players[1].allTrumpConfirmed, true);
  assert.deepEqual(beliefs.players[1].voidSuits, ['C', 'D', 'S']);
  assert.equal(JSON.stringify(beliefs).includes('lead-s'), false, '快照只含汇总判断，不携带牌面或牌 id');
});

test('已确认对手全主能全毙时先兑现大鬼，朋友在确定大鬼墩安全上分', () => {
  const cashout = playView({
    seat: 2,
    declarerSeat: 1,
    hand: [
      card('cashout-big', 'JOKER', 16),
      card('cashout-c3', 'C', 3),
      card('cashout-c4', 'C', 4),
      card('cashout-c6', 'C', 6),
    ],
    trickHistory: [{ trickNo: 1, leadSeat: 1, leadSuit: 'S', plays: [] }],
  });
  cashout.botBeliefs = {
    kittySlots: 8,
    players: {
      1: { seat: 1, team: 1, handCount: 4, allTrumpConfirmed: true },
    },
  };
  assert.equal(chooseLeadCards(cashout)[0].id, 'cashout-big');

  const feed = playView({
    seat: 2,
    declarerSeat: 1,
    hand: [card('feed-main-5', 'H', 5), card('feed-main-3', 'H', 3)],
    trickHistory: [{ trickNo: 1, leadSeat: 1, leadSuit: 'S', plays: [] }],
    currentTrick: [
      { seat: 0, playSuit: 'TRUMP', cards: [card('partner-big', 'JOKER', 16)] },
    ],
  });
  assert.equal(chooseFollowCards(feed)[0].id, 'feed-main-5');
});

test('庄家首轮没有双大鬼时先吊最小主牌', () => {
  const view = playView({
    seat: 0,
    declarerSeat: 0,
    hand: [card('trump-3', 'H', 3), card('spade-3', 'S', 3), card('spade-8', 'S', 8)],
  });
  assert.deepEqual(chooseLeadCards(view).map(c => c.id), ['trump-3']);
});

test('回应庄家首轮吊主：用安全大主争牌权，取得下一轮表示机会', () => {
  const oneBig = playView({
    seat: 2,
    declarerSeat: 0,
    hand: [
      card('big-joker', 'JOKER', 16),
      card('small-joker', 'JOKER', 15),
      card('trump-a', 'H', 14),
    ],
    currentTrick: [
      { seat: 0, playSuit: 'TRUMP', cards: [card('declarer-trump-3', 'H', 3)] },
    ],
  });
  assert.equal(chooseFollowCards(oneBig)[0].id, 'trump-a');

  const contested = playView({
    seat: 2,
    declarerSeat: 0,
    hand: [
      card('contested-a', 'H', 14),
      card('contested-side-rank', 'S', 2),
      card('contested-main-rank', 'H', 2),
      card('contested-low', 'H', 7),
      card('contested-small-joker', 'JOKER', 15),
    ],
    currentTrick: [
      { seat: 0, playSuit: 'TRUMP', cards: [card('contested-lead', 'H', 3)] },
      { seat: 1, cards: [card('opponent-a', 'H', 14)] },
    ],
  });
  assert.equal(
    chooseFollowCards(contested)[0].id,
    'contested-side-rank',
    '对手已出主A时，要用刚好能取得当前领先的副级牌，而不是机械地再出A'
  );

  const cannotTakeSafely = playView({
    seat: 2,
    declarerSeat: 0,
    hand: [
      card('blocked-a', 'H', 14),
      card('blocked-side-rank', 'S', 2),
      card('blocked-low', 'H', 7),
      card('blocked-small-joker', 'JOKER', 15),
    ],
    currentTrick: [
      { seat: 0, playSuit: 'TRUMP', cards: [card('blocked-lead', 'H', 3)] },
      { seat: 1, cards: [card('opponent-main-rank', 'H', 2)] },
    ],
  });
  assert.equal(
    chooseFollowCards(cannotTakeSafely)[0].id,
    'blocked-low',
    '小鬼以下已无法夺权时不空耗A或级牌，也不为普通表示动小鬼'
  );

  const twoBig = playView({
    seat: 2,
    declarerSeat: 0,
    hand: [
      card('big-joker-1', 'JOKER', 16),
      card('big-joker-2', 'JOKER', 16),
      card('small-joker', 'JOKER', 15),
    ],
    currentTrick: [
      { seat: 0, playSuit: 'TRUMP', cards: [card('declarer-trump-3', 'H', 3)] },
    ],
  });
  assert.equal(chooseFollowCards(twoBig)[0].rank, 15, '没有普通主牌时才被迫出较小的小鬼');

  const weakTrump = playView({
    seat: 2,
    declarerSeat: 0,
    hand: [
      card('weak-big', 'JOKER', 16),
      card('weak-small', 'JOKER', 15),
      card('trump-k', 'H', 13),
      card('trump-7', 'H', 7),
    ],
    currentTrick: [
      { seat: 0, playSuit: 'TRUMP', cards: [card('weak-lead', 'H', 3)] },
    ],
  });
  assert.equal(chooseFollowCards(weakTrump)[0].id, 'trump-7', '没有A以上的主就用小主表示主不大');

  const rankAce = playView({
    seat: 2,
    declarerSeat: 0,
    hand: [card('side-rank-a', 'S', 14), card('trump-k', 'H', 13), card('small', 'JOKER', 15)],
    currentTrick: [
      { seat: 0, playSuit: 'TRUMP', cards: [card('rank-a-lead', 'H', 3)] },
    ],
  });
  rankAce.round.rankCard = 14;
  assert.equal(chooseFollowCards(rankAce)[0].id, 'side-rank-a', '打A时副级A也属于表示牌');

  const reviewView = playView({
    seat: 2,
    declarerSeat: 0,
    hand: [
      card('review-big', 'JOKER', 16),
      card('review-small', 'JOKER', 15),
      ...[4, 6, 7, 8, 9, 10, 11].map(rank => card(`review-trump-${rank}`, 'H', rank)),
    ],
    currentTrick: [
      { seat: 0, playSuit: 'TRUMP', cards: [card('review-lead', 'H', 3)] },
    ],
  });
  const review = inspectBotPlay(reviewView, { type: 'play', cardIds: ['review-big'] });
  assert.ok(review.issues.some(issue => issue.type === 'CONTROL_WASTE'));

  const missedControl = inspectBotPlay(contested, {
    type: 'play',
    cardIds: ['contested-low'],
  });
  assert.ok(
    missedControl.issues.some(issue => issue.type === 'OPENING_CONTROL'),
    '有安全大主可以夺权却出小牌，应在局末复盘中指出'
  );

  const futileSignal = inspectBotPlay(cannotTakeSafely, {
    type: 'play',
    cardIds: ['blocked-a'],
  });
  assert.ok(
    futileSignal.issues.some(issue => issue.type === 'OPENING_CONTROL'),
    '大主没有换来牌权时，应在局末复盘中指出'
  );
});

test('电脑难度可调：简单档不做完整表示推断，普通以上保留鬼', () => {
  assert.equal(normalizeBotDifficulty('1'), 'easy');
  assert.equal(normalizeBotDifficulty('normal'), 'normal');
  assert.equal(normalizeBotDifficulty('unknown'), 'expert');

  const view = playView({
    seat: 2,
    declarerSeat: 0,
    hand: [card('big-joker', 'JOKER', 16), card('small-joker', 'JOKER', 15)],
    currentTrick: [
      { seat: 0, playSuit: 'TRUMP', cards: [card('declarer-trump-3', 'H', 3)] },
    ],
  });
  view.botDifficulty = 'easy';
  assert.equal(chooseFollowCards(view)[0].id, 'big-joker');
  view.botDifficulty = 'normal';
  assert.equal(chooseFollowCards(view)[0].id, 'small-joker');
});

test('庄家朋友夺权后领牌表示，庄家取得牌权后优先回应这门花色', () => {
  const partnerSignal = playView({
    seat: 2,
    declarerSeat: 0,
    hand: [
      card('signal-club-3', 'C', 3),
      card('signal-club-4', 'C', 4),
      card('signal-club-6', 'C', 6),
      card('signal-club-7', 'C', 7),
      card('signal-club-8', 'C', 8),
      card('signal-spade-3', 'S', 3),
    ],
    trickHistory: [
      { trickNo: 1, leadSeat: 0, leadSuit: 'TRUMP', winnerSeat: 2, plays: [] },
    ],
    piecesView: {
      S: [],
      D: [],
      C: [
        { rank: 14, status: 'unseen' },
        { rank: 14, status: 'unseen' },
        { rank: 13, status: 'unseen' },
        { rank: 13, status: 'unseen' },
      ],
    },
  });
  assert.equal(
    chooseLeadCards(partnerSignal)[0].id,
    'signal-club-3',
    '朋友拿到主动权后，用长门小牌表达这门牌的意图'
  );

  const declarerReadsSignal = playView({
    seat: 0,
    declarerSeat: 0,
    hand: [
      card('read-club-4', 'C', 4),
      card('read-diamond-3', 'D', 3),
      card('read-spade-4', 'S', 4),
    ],
    trickHistory: [
      { trickNo: 1, leadSeat: 0, leadSuit: 'TRUMP', winnerSeat: 2, plays: [] },
      {
        trickNo: 2,
        leadSeat: 2,
        leadSuit: 'C',
        winnerSeat: 0,
        plays: [{ seat: 2, playSuit: 'C', cards: [card('partner-club-3', 'C', 3)] }],
      },
    ],
  });
  assert.equal(
    chooseLeadCards(declarerReadsSignal)[0].id,
    'read-club-4',
    '庄家重新取得牌权后优先回朋友表示过的花色'
  );
});

test('进化权重会补默认值、拒绝 NaN 并限制在安全搜索范围', () => {
  const tuning = normalizeBotTuning({
    preserveWeight: 999,
    coverRiskWeight: Number.NaN,
    earlyThrowMinLength: 4.7,
    opponentThreatThreshold: -10,
  });
  assert.equal(tuning.preserveWeight, BOT_TUNING_BOUNDS.preserveWeight[1]);
  assert.equal(tuning.coverRiskWeight, 1);
  assert.equal(tuning.earlyThrowMinLength, 5);
  assert.equal(tuning.opponentThreatThreshold, BOT_TUNING_BOUNDS.opponentThreatThreshold[0]);
});

test('对家配合：朋友小牌求件时贡献 A，没件时第三手用 J 压过对手的先出 6', () => {
  const contribute = playView({
    seat: 2,
    hand: [card('contribute-6', 'S', 6), card('contribute-j', 'S', 11), card('contribute-k', 'S', 13), card('contribute-a', 'S', 14)],
    currentTrick: [
      { seat: 0, playSuit: 'S', cards: [card('partner-probe-3', 'S', 3)] },
      { seat: 3, cards: [card('opponent-6', 'S', 6)] },
    ],
  });
  assert.equal(chooseFollowCards(contribute)[0].id, 'contribute-a', '朋友求件时 A 要主动贡献');
  assert.equal(
    inspectBotPlay(contribute, { type: 'play', cardIds: ['contribute-a'] }).issues.some(
      issue => issue.type === 'UNSAFE_POINT' || issue.type === 'OVERPLAY'
    ),
    false,
    '局后复盘不能又把正确的对家贡献当成浪费'
  );

  const cover = playView({
    seat: 2,
    hand: [card('cover-6', 'S', 6), card('cover-j', 'S', 11)],
    currentTrick: [
      { seat: 0, playSuit: 'S', cards: [card('partner-probe-4', 'S', 4)] },
      { seat: 3, cards: [card('opponent-first-6', 'S', 6)] },
    ],
  });
  assert.equal(
    chooseFollowCards(cover)[0].id,
    'cover-j',
    '后出同点 6 压不过对手的先出 6，有 J 就必须用 J 封门'
  );
  assert.equal(
    inspectBotPlay(cover, { type: 'play', cardIds: ['cover-j'] }).issues.some(issue => issue.type === 'OVERPLAY'),
    false,
    '第三手封门是队友协议，不应被复盘反向学成“出牌过大”'
  );
});

test('牌友约定是可学习的强先验，极端风险下可以例外', () => {
  const view = playView({
    seat: 2,
    hand: [
      card('soft-k', 'S', 13),
      card('soft-j', 'S', 11),
      card('soft-c3', 'C', 3),
      card('soft-c4', 'C', 4),
      card('soft-c6', 'C', 6),
      card('soft-d3', 'D', 3),
      card('soft-d4', 'D', 4),
      card('soft-d6', 'D', 6),
      card('soft-d7', 'D', 7),
    ],
    currentTrick: [
      { seat: 0, playSuit: 'S', cards: [card('soft-partner-3', 'S', 3)] },
      { seat: 3, cards: [card('soft-opponent-6', 'S', 6)] },
    ],
  });
  assert.equal(chooseFollowCards(view)[0].id, 'soft-k', '默认强先验会响应朋友求件');

  view.botTuning = {
    conventionPriorWeight: 0.25,
    pointExposureWeight: 2.2,
    coverRiskWeight: 2.2,
  };
  assert.equal(
    chooseFollowCards(view)[0].id,
    'soft-j',
    '学到极度警惕末家反超时，可以不拆 K 件而用 J 封住牌面'
  );
});

test('对家配合：朋友出 5/10/K 强烈求 A，朋友的大牌已封住时走分', () => {
  for (const [rank, label] of [[5, '5'], [10, '10'], [13, 'K']]) {
    const askAce = playView({
      seat: 2,
      hand: [card(`answer-${label}-3`, 'S', 3), card(`answer-${label}-j`, 'S', 11), card(`answer-${label}-a`, 'S', 14)],
      currentTrick: [
        { seat: 0, playSuit: 'S', cards: [card(`partner-${label}`, 'S', rank)] },
        { seat: 3, cards: [card(`opponent-${label}-6`, 'S', 6)] },
      ],
    });
    assert.equal(chooseFollowCards(askAce)[0].rank, 14, `朋友出 ${label} 时应用 A 回应`);
  }

  const feedSecureAce = playView({
    seat: 2,
    hand: [card('feed-secure-3', 'S', 3), card('feed-secure-10', 'S', 10), card('feed-secure-k', 'S', 13)],
    currentTrick: [
      { seat: 0, playSuit: 'S', cards: [card('partner-secure-a', 'S', 14)] },
      { seat: 3, cards: [card('opponent-secure-6', 'S', 6)] },
    ],
  });
  assert.equal(chooseFollowCards(feedSecureAce)[0].id, 'feed-secure-10', 'A 已封住时优先走 10 分，不拆 K 件');

  const unsafeAce = playView({
    seat: 2,
    hand: [card('unsafe-a-3', 'S', 3), card('unsafe-a-10', 'S', 10)],
    trickHistory: [{
      leadSuit: 'S',
      plays: [
        { seat: 0, playSuit: 'S', cards: [card('old-lead-s', 'S', 7)] },
        { seat: 1, cards: [card('last-seat-cut', 'H', 3)] },
      ],
    }],
    currentTrick: [
      { seat: 0, playSuit: 'S', cards: [card('partner-unsafe-a', 'S', 14)] },
      { seat: 3, cards: [card('opponent-unsafe-6', 'S', 6)] },
    ],
  });
  assert.equal(chooseFollowCards(unsafeAce)[0].id, 'unsafe-a-3', '已知最后一家断门可杀时，A 不算确定大');
});

test('朋友求件，贡献第一件拿到牌权后立即续打同门第二件', () => {
  const continued = playView({
    seat: 2,
    hand: [
      card('continuation-k', 'S', 13),
      card('continuation-a-2', 'S', 14),
      card('continuation-7', 'S', 7),
      card('continuation-c3', 'C', 3),
    ],
    trickHistory: [{
      trickNo: 1,
      leadSeat: 0,
      leadSuit: 'S',
      winnerSeat: 2,
      plays: [
        { seat: 0, playSuit: 'S', cards: [card('partner-request-3', 'S', 3)] },
        { seat: 3, cards: [card('opponent-request-4', 'S', 4)] },
        { seat: 2, cards: [card('first-contribution-a', 'S', 14)] },
        { seat: 1, cards: [card('opponent-request-6', 'S', 6)] },
      ],
    }],
  });
  assert.equal(
    chooseLeadCards(continued)[0].id,
    'continuation-k',
    '手里还有 K 和第二张 A 时，先续打 K 求剩下的 A'
  );

  const didNotWin = playView({
    seat: 2,
    hand: [card('no-continuation-k', 'S', 13), card('no-continuation-7', 'S', 7), card('no-continuation-c3', 'C', 3)],
    trickHistory: [{
      trickNo: 1,
      leadSeat: 0,
      leadSuit: 'S',
      winnerSeat: 1,
      plays: [
        { seat: 0, playSuit: 'S', cards: [card('partner-request-again-3', 'S', 3)] },
        { seat: 3, cards: [card('opponent-request-again-4', 'S', 4)] },
        { seat: 2, cards: [card('first-contribution-again-a', 'S', 14)] },
        { seat: 1, cards: [card('last-seat-kill', 'H', 3)] },
      ],
    }],
  });
  assert.notEqual(chooseLeadCards(didNotWin)[0].id, 'no-continuation-k', '没拿到牌权时不得伪触发续件');
});

test('第三手会封住最后一家用 10/K 吃分；朋友求件时仍优先贡献 A', () => {
  const exposed = playView({
    seat: 2,
    declarerSeat: 0,
    hand: [card('spade-6', 'S', 6), card('spade-j', 'S', 11), card('spade-a', 'S', 14)],
    currentTrick: [
      { seat: 0, playSuit: 'S', cards: [card('partner-4', 'S', 4)] },
      { seat: 3, cards: [card('opponent-3', 'S', 3)] },
    ],
  });
  exposed.botDifficulty = 'easy';
  assert.equal(chooseFollowCards(exposed)[0].id, 'spade-6');
  exposed.botDifficulty = 'expert';
  assert.equal(chooseFollowCards(exposed)[0].id, 'spade-a');
  const riskyChoice = evaluateFollowChoices(exposed)
    .find(choice => choice.cards[0].id === 'spade-6');
  assert.equal(riskyChoice.lastSeatPointRisk, 2.5);
  const review = inspectBotPlay(exposed, { type: 'play', cardIds: ['spade-6'] });
  assert.ok(review.issues.some(issue => issue.type === 'LAST_SEAT_POINT'));

  const journal = new BotReviewJournal();
  journal.record(exposed, { type: 'play', cardIds: ['spade-6'] });
  const learningState = {
    phase: 'SCORING', // 复盘只在局末生成（bot-review 的保密闸门会校验这一点）
    rounds: [{ roundNumber: 1, declarerSeat: 0, kittyGrab: true }],
    round: { roundNumber: 1, trickHistory: [{ trickNo: 1, winnerSeat: 1 }] },
    botLearning: {},
  };
  journal.finalizeCompletedRounds(learningState);
  assert.equal(learningState.rounds[0].botReview.counts.lastSeatPoint, 1);
  assert.ok(learningState.botLearning.shared.coverCaution > 1);

  const knownSafe = playView({
    seat: 2,
    declarerSeat: 0,
    hand: [
      card('spade-3', 'S', 3),
      card('spade-a', 'S', 14),
      card('spade-5-1', 'S', 5),
      card('spade-5-2', 'S', 5),
      card('spade-10-1', 'S', 10),
      card('spade-10-2', 'S', 10),
      card('spade-k-1', 'S', 13),
      card('spade-k-2', 'S', 13),
    ],
    currentTrick: [
      { seat: 0, playSuit: 'S', cards: [card('partner-4', 'S', 4)] },
      { seat: 3, cards: [card('opponent-3', 'S', 3)] },
    ],
  });
  assert.equal(chooseFollowCards(knownSafe)[0].id, 'spade-a');
});

test('朋友已经领先时送分，而不是机械地出最小牌', () => {
  const view = playView({
    seat: 2,
    hand: [card('spade-3', 'S', 3), card('spade-5', 'S', 5)],
    currentTrick: [
      { seat: 1, playSuit: 'S', cards: [card('opponent-9', 'S', 9)] },
      { seat: 0, cards: [card('partner-10', 'S', 10)] },
      { seat: 3, cards: [card('opponent-8', 'S', 8)] },
    ],
  });
  assert.deepEqual(chooseFollowCards(view).map(c => c.id), ['spade-5']);
});

test('对手小牌求件时，有 J 可选就不用 K 帮对手消件', () => {
  const view = playView({
    seat: 0,
    hand: [card('spade-j', 'S', 11), card('spade-k', 'S', 13)],
    currentTrick: [
      { seat: 1, playSuit: 'S', cards: [card('opponent-3', 'S', 3)] },
    ],
    piecesView: {
      S: [
        { rank: 14, status: 'unseen' },
        { rank: 14, status: 'seen' },
        { rank: 13, status: 'mine' },
        { rank: 13, status: 'seen' },
      ],
      D: [],
      C: [],
    },
  });
  assert.deepEqual(chooseFollowCards(view).map(c => c.id), ['spade-j']);

  const review = inspectBotPlay(view, { type: 'play', cardIds: ['spade-k'] });
  assert.ok(review.issues.some(issue => issue.type === 'PIECE_HELP'));
  assert.ok(review.issues.some(issue => issue.type === 'UNSAFE_POINT'));
});

test('局末复盘汇总逐手风险，并把教训共享给下一局的所有电脑', () => {
  const view = playView({
    seat: 0,
    hand: [card('spade-j', 'S', 11), card('spade-k', 'S', 13)],
    currentTrick: [
      { seat: 1, playSuit: 'S', cards: [card('opponent-3', 'S', 3)] },
    ],
    piecesView: {
      S: [
        { rank: 14, status: 'unseen' },
        { rank: 14, status: 'seen' },
        { rank: 13, status: 'mine' },
        { rank: 13, status: 'seen' },
      ],
      D: [],
      C: [],
    },
  });
  const journal = new BotReviewJournal();
  journal.record(view, { type: 'play', cardIds: ['spade-k'] });
  const defenderView = playView({
    seat: 1,
    hand: [card('club-3', 'C', 3)],
  });
  defenderView.you.id = 'OTHER';
  defenderView.you.nickname = '电脑乙';
  journal.record(defenderView, { type: 'play', cardIds: ['club-3'] });
  const state = {
    phase: 'SCORING', // 复盘只在局末生成（bot-review 的保密闸门会校验这一点）
    rounds: [{ roundNumber: 1, declarerSeat: 0, kittyGrab: true }],
    round: {
      roundNumber: 1,
      trickHistory: [{ trickNo: 1, winnerSeat: 1 }],
    },
    botLearning: {},
  };
  journal.finalizeCompletedRounds(state);

  assert.equal(state.rounds[0].botReview.reviewedPlays, 2);
  assert.equal(state.rounds[0].botReview.counts.pieceHelp, 1);
  assert.equal(state.rounds[0].botReview.counts.unsafePoint, 1);
  assert.ok(state.botLearning.players.BOT.pieceCaution > 1);
  assert.ok(state.botLearning.players.BOT.pointCaution > 1);
  assert.equal(state.botLearning.shared.roundsReviewed, 1);
  assert.equal(state.botLearning.shared.playsReviewed, 2);
  assert.ok(state.botLearning.shared.pieceCaution > 1);
  assert.ok(state.botLearning.shared.pointCaution > 1);
  assert.ok(state.botLearning.shared.dealerBottomWeight > 1, '庄家被扣底后提高保底权重');
  assert.equal(state.botLearning.shared.defenderBottomGrabbed, 1);

  const unseenBotProfile = botLearningProfile(state, 'NEW_BOT');
  assert.ok(unseenBotProfile.pieceCaution > 1, '没犯过该错误的新电脑也继承共享教训');
  assert.ok(unseenBotProfile.pointCaution > 1);
  assert.equal(unseenBotProfile.dealerBottomWeight, state.botLearning.shared.dealerBottomWeight);
});

test('每局结果都会累计庄闲保底/扣底样本，并在失败时调整尾盘权重', () => {
  const journal = new BotReviewJournal();
  // 复盘只在局末生成（bot-review 的保密闸门会校验这一点）
  const state = { phase: 'SCORING', rounds: [], round: null, botLearning: {} };

  const dealerView = playView({ seat: 0, hand: [card('s3-r1', 'S', 3)] });
  journal.record(dealerView, { type: 'play', cardIds: ['s3-r1'] });
  state.rounds.push({ roundNumber: 1, declarerSeat: 0, kittyGrab: false });
  state.round = { roundNumber: 1, trickHistory: [] };
  journal.finalizeCompletedRounds(state);
  assert.equal(state.botLearning.shared.dealerRounds, 1);
  assert.equal(state.botLearning.shared.dealerBottomSaved, 1);

  const defenderView = playView({ seat: 1, hand: [card('c3-r2', 'C', 3)] });
  defenderView.you.id = 'DEFENDER';
  defenderView.round.roundNumber = 2;
  journal.record(defenderView, { type: 'play', cardIds: ['c3-r2'] });
  state.rounds.push({ roundNumber: 2, declarerSeat: 0, kittyGrab: false });
  state.round = { roundNumber: 2, trickHistory: [] };
  journal.finalizeCompletedRounds(state);

  assert.equal(state.botLearning.shared.roundsReviewed, 2);
  assert.equal(state.botLearning.shared.defenderRounds, 1);
  assert.equal(state.botLearning.shared.defenderBottomGrabbed, 0);
  assert.ok(state.botLearning.shared.defenderBottomWeight > 1, '闲家没扣底后提高扣底权重');
  assert.equal(state.rounds[1].botReview.learning.roundsReviewed, 2);
});

test('复盘学到的保底权重会实际改变尾盘候选牌评分', () => {
  const view = playView({
    seat: 2,
    declarerSeat: 0,
    hand: [card('spade-3', 'S', 3), card('spade-j', 'S', 11)],
    currentTrick: [
      { seat: 1, playSuit: 'S', cards: [card('opponent-9', 'S', 9)] },
    ],
  });
  view.botProfile = { dealerBottomWeight: 1, defenderBottomWeight: 1 };
  const baseline = evaluateFollowChoices(view)
    .find(choice => choice.cards[0].id === 'spade-j').score;

  view.botProfile = { dealerBottomWeight: 2.5, defenderBottomWeight: 1 };
  const learned = evaluateFollowChoices(view)
    .find(choice => choice.cards[0].id === 'spade-j').score;
  assert.ok(learned > baseline + 300, '保底失败积累的权重用于下一局尾盘争牌权');
});

test('对手领先但桌面无分时，早盘不浪费主牌去杀', () => {
  const view = playView({
    seat: 3,
    hand: [
      card('trump-3', 'H', 3),
      card('club-3', 'C', 3),
      card('club-4', 'C', 4),
      card('club-6', 'C', 6),
      card('diamond-3', 'D', 3),
      card('diamond-4', 'D', 4),
      card('diamond-6', 'D', 6),
      card('diamond-7', 'D', 7),
      card('diamond-8', 'D', 8),
    ],
    currentTrick: [
      { seat: 0, playSuit: 'S', cards: [card('opponent-9', 'S', 9)] },
    ],
  });
  assert.notEqual(chooseFollowCards(view)[0].id, 'trump-3');
});

test('对手领先且桌面有分时，用最小主牌杀', () => {
  const view = playView({
    seat: 3,
    hand: [
      card('trump-3', 'H', 3),
      card('club-3', 'C', 3),
      card('club-4', 'C', 4),
      card('club-6', 'C', 6),
      card('diamond-3', 'D', 3),
      card('diamond-4', 'D', 4),
      card('diamond-6', 'D', 6),
      card('diamond-7', 'D', 7),
      card('diamond-8', 'D', 8),
    ],
    currentTrick: [
      { seat: 0, playSuit: 'S', cards: [card('opponent-10', 'S', 10)] },
    ],
  });
  assert.equal(chooseFollowCards(view)[0].id, 'trump-3');
});

test('AKK 缺一支 A 时出 K 求件', () => {
  const view = playView({
    hand: [
      card('spade-a', 'S', 14),
      card('spade-k1', 'S', 13),
      card('spade-k2', 'S', 13),
      card('spade-7', 'S', 7),
      card('club-3', 'C', 3),
    ],
    piecesView: {
      S: [
        { rank: 14, status: 'mine' },
        { rank: 14, status: 'unseen' },
        { rank: 13, status: 'mine' },
        { rank: 13, status: 'mine' },
      ],
      D: [],
      C: [],
    },
  });
  assert.ok(['spade-k1', 'spade-k2'].includes(chooseLeadCards(view)[0].id));
});

test('无件长门用最小无分牌探件', () => {
  const view = playView({
    hand: [
      card('club-3', 'C', 3),
      card('club-4', 'C', 4),
      card('club-6', 'C', 6),
      card('club-7', 'C', 7),
      card('club-8', 'C', 8),
      card('club-9', 'C', 9),
      card('spade-3', 'S', 3),
    ],
    piecesView: {
      S: [],
      D: [],
      C: [
        { rank: 14, status: 'unseen' },
        { rank: 14, status: 'unseen' },
        { rank: 13, status: 'unseen' },
        { rank: 13, status: 'unseen' },
      ],
    },
  });
  assert.deepEqual(chooseLeadCards(view).map(c => c.id), ['club-3']);
});

test('按动作类型使用思考时间，领牌比跟牌更慢', () => {
  const follow = botDelayForDecision({ action: { type: 'play' }, isLead: false }, () => 0);
  const lead = botDelayForDecision({ action: { type: 'play' }, isLead: true }, () => 0);
  const exchange = botDelayForDecision({ action: { type: 'buryKitty' } }, () => 1);
  assert.equal(follow, 1400);
  assert.equal(lead, 2200);
  assert.equal(exchange, 4200);
});

test('一个真人加三个电脑可以自动完成整场游戏', { timeout: 15_000 }, async t => {
  const state = createInitialState(mulberry32(42));
  state.seed = 42;
  state.teamLevels = [13, 13]; // 任一方首次升级即可结束，缩短集成测试
  state.niiRandom = () => 1;
  applyAction(state, { type: 'join' }, 'T');
  for (const id of ['H', 'B', 'M']) {
    assert.equal(applyAction(state, { type: 'addBot', playerId: id }, 'T').ok, true);
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
      scoringMs: 1,
      roundEndMs: 1,
      playMs: 50,
      crossRiverDecideMs: 1,
      crossRiverPickMs: 10,
      autoLastMs: 1,
    },
  });
  const botErrors = [];
  const controller = new BotController({
    engine,
    delayMs: 1,
    onError: (playerId, error) => botErrors.push({ playerId, error }),
  });
  engine.attachBotController(controller);
  t.after(() => {
    controller.stop();
    engine.clearTimers();
  });

  const deadline = Date.now() + 12_000;
  while (state.phase !== 'GAME_OVER' && Date.now() < deadline) {
    // 用同一套公开视角策略模拟唯一真人的操作；另外三家完全由 BotController 驱动。
    const humanView = viewerState(state, 'T');
    const action = decideBotAction(humanView);
    if (action) {
      const result = engine.applyAction({ ...action, phase: humanView.phase }, 'T');
      assert.equal(result.ok, true, `真人模拟动作失败：${result.error?.reason}`);
    }
    await sleep(1);
  }

  assert.equal(state.phase, 'GAME_OVER');
  assert.notEqual(state.gameWinnerTeam, null);
  assert.ok(state.rounds.length >= 1);
  assert.ok(state.rounds.every(round => round.conservationOk), '每局分数守恒');
  assert.ok(
    state.rounds.every(round => round.botReview?.reviewedPlays > 0),
    '每局结束后都生成电脑逐手复盘'
  );
  assert.deepEqual(botErrors, []);
});

// ---- 电脑动作被拒后的自愈（回归：曾经一次被拒就永久停手，大厅阶段会锁死整局）----

function stuckControllerFixture({ ok = false } = {}) {
  const state = createInitialState(mulberry32(7));
  for (const player of state.players) {
    player.isBot = true;
    player.connected = true;
  }
  const attempts = [];
  const engine = {
    state,
    applyAction(action, playerId) {
      attempts.push({ type: action.type, playerId });
      return ok
        ? { ok: true }
        : { ok: false, error: { code: 'WRONG_PHASE', reason: '测试强制拒绝' } };
    },
  };
  const errors = [];
  const controller = new BotController({
    engine,
    delayMs: 1,
    retryBaseMs: 1,
    maxRetries: 3,
    onError: (playerId, error) => errors.push(error),
  });
  return { controller, attempts, errors, state };
}

test('电脑动作被拒后会退避重试，而不是永久停手', async t => {
  const { controller, attempts, errors } = stuckControllerFixture();
  t.after(() => controller.stop());

  controller.schedule();
  await sleep(120);

  // 修复前：只会尝试 1 次然后彻底不动。修复后：1 次首发 + maxRetries 次重试。
  assert.equal(attempts.length, 4, `应为 1 次首发 + 3 次重试，实际 ${attempts.length}`);
  assert.ok(attempts.every(a => a.type === attempts[0].type), '重试的是同一个动作');
});

test('电脑连续被拒到上限后停手并报 BOT_STUCK，不会无限空转', async t => {
  const { controller, attempts, errors } = stuckControllerFixture();
  t.after(() => controller.stop());

  controller.schedule();
  await sleep(120);
  const settled = attempts.length;
  await sleep(120); // 再等一轮，确认真的停了

  assert.equal(attempts.length, settled, '到上限后不再继续尝试');
  assert.equal(errors.at(-1).code, 'BOT_STUCK', '最后一条错误是 BOT_STUCK');
  assert.equal(controller.timer, null, '没有遗留的重试计时器');
});

test('动作成功时不进重试路径，重试计数保持为 0', async t => {
  const { controller, attempts, errors } = stuckControllerFixture({ ok: true });
  t.after(() => controller.stop());

  controller.schedule();
  await sleep(60);

  assert.equal(attempts.length, 1, '成功后由 afterAction→schedule 接管，不自行重排');
  assert.deepEqual(errors, [], '成功不应产生错误回调');
  assert.equal(controller.retries, 0);
});

test('真人推进状态后，电脑的重试计数清零（不会带着旧账继续退避）', async t => {
  const { controller } = stuckControllerFixture();
  t.after(() => controller.stop());

  controller.schedule();
  await sleep(120);
  assert.ok(controller.retries > 0, '先积累失败计数');

  controller.schedule(); // 模拟真人动作触发的 afterAction → schedule()
  assert.equal(controller.retries, 0);
});

// ---- 复盘保密闸门（examples 含牌名且全场广播，只能在局末生成）----

test('局未打完就生成电脑复盘会直接抛错（字符串牌名绕不过递归扫描器，靠这道闸门兜住）', () => {
  const state = createInitialState(mulberry32(11));
  state.phase = 'PLAYING';
  state.round = { roundNumber: 1, trickHistory: [] };
  // 手上还有牌 = 这一局还没打完，牌面尚未全部公开
  state.players[0].hand = [{ id: 'x1', suit: 'S', rank: 14 }];
  state.rounds = [{ roundNumber: 1 }];

  const journal = new BotReviewJournal();
  journal.records = [{ roundNumber: 1, playerId: 'T', team: 0, trickNo: 3, issues: [] }];

  assert.throws(
    () => journal.finalizeCompletedRounds(state),
    /安全底线.*第 1 局结束前/,
    '局中生成复盘必须抛错'
  );
  assert.equal(state.rounds[0].botReview, undefined, '抛错后不得残留 botReview');
});

test('局末（手牌已清空 / SCORING）生成复盘正常放行', () => {
  const state = createInitialState(mulberry32(11));
  state.phase = 'SCORING';
  state.round = { roundNumber: 1, trickHistory: [] };
  for (const player of state.players) player.hand = [];
  state.rounds = [{ roundNumber: 1 }];

  const journal = new BotReviewJournal();
  journal.records = [{ roundNumber: 1, playerId: 'T', team: 0, trickNo: 3, issues: [] }];

  journal.finalizeCompletedRounds(state);
  assert.equal(state.rounds[0].botReview.reviewedPlays, 1);
});

test('复盘描述的是更早已结束的局时，不受当前局阶段影响', () => {
  const state = createInitialState(mulberry32(11));
  state.phase = 'PLAYING'; // 第 2 局正在打
  state.round = { roundNumber: 2, trickHistory: [] };
  state.players[0].hand = [{ id: 'x1', suit: 'S', rank: 14 }];
  state.rounds = [{ roundNumber: 1 }]; // 第 1 局早已结束

  const journal = new BotReviewJournal();
  journal.records = [{ roundNumber: 1, playerId: 'T', team: 0, trickNo: 3, issues: [] }];

  journal.finalizeCompletedRounds(state);
  assert.equal(state.rounds[0].botReview.reviewedPlays, 1);
});

test('PHASES 常量覆盖代码中实际会出现的每一个阶段（含 DOMINANCE）', () => {
  // 回归：DOMINANCE 曾在 actions.js 里被赋值却没进 PHASES，
  // 让这个自称「唯一真源」的常量表实际上是残缺的。
  assert.ok(PHASES.includes('DOMINANCE'), 'PHASES 必须包含 DOMINANCE');
  assert.equal(new Set(PHASES).size, PHASES.length, 'PHASES 不得有重复项');
  assert.ok(
    PHASES.indexOf('DOMINANCE') > PHASES.indexOf('PLAYING'),
    'DOMINANCE 排在 PLAYING 之后'
  );
  assert.ok(
    PHASES.indexOf('DOMINANCE') < PHASES.indexOf('SCORING'),
    'DOMINANCE 排在 SCORING 之前'
  );
});
