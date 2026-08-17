import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateLeadPlay,
  validateFollowPlay,
  resolveTrick,
  trickLeader,
  assertEqualHandCounts,
  TrickError,
} from '../trick.js';

const c = (id, suit, rank) => ({ id, suit, rank });
const ctx = { trumpSuit: 'H', rankCard: 2 };

// 黑桃四件全部未现（模拟极端：谁都不能甩黑桃）
const allUnseenS = [
  { rank: 14, status: 'unseen' }, { rank: 14, status: 'unseen' },
  { rank: 13, status: 'unseen' }, { rank: 13, status: 'unseen' },
];
const allMineS = [
  { rank: 14, status: 'mine' }, { rank: 14, status: 'mine' },
  { rank: 13, status: 'mine' }, { rank: 13, status: 'mine' },
];
const piecesView = { S: allUnseenS, D: allUnseenS, C: allUnseenS };

// ---- validateLeadPlay ----

test('首家单张：任何牌合法，N=1 跳过甩牌判定（即使该花色四件全未现）', () => {
  const hand = [c('s7', 'S', 7), c('h3', 'H', 3)];
  const r = validateLeadPlay({ hand, piecesView, trumpSuit: 'H', rankCard: 2 }, ['s7']);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'single');
  assert.equal(r.playSuit, 'S');
  const r2 = validateLeadPlay({ hand, piecesView, trumpSuit: 'H', rankCard: 2 }, ['h3']);
  assert.equal(r2.playSuit, 'TRUMP', '主牌单张合法（playSuit=TRUMP）');
});

test('首家甩牌：主牌放行（trumpThrow，资格由服务端另裁）、必须同花色、副牌资格不成立时提示还差哪件', () => {
  const hand = [c('s7', 'S', 7), c('s8', 'S', 8), c('d9', 'D', 9), c('h3', 'H', 3), c('h4', 'H', 4)];
  // 主牌甩牌放行：不给提示、不提前拒绝（算错由服务端收缩为最小一张）
  const r1 = validateLeadPlay({ hand, piecesView: { S: allMineS }, trumpSuit: 'H', rankCard: 2 }, ['h3', 'h4']);
  assert.equal(r1.ok, true);
  assert.equal(r1.kind, 'trumpThrow');
  assert.equal(r1.playSuit, 'TRUMP');
  // 混花色（含主牌+副牌）仍拒绝
  assert.equal(
    validateLeadPlay({ hand, piecesView: { S: allMineS }, trumpSuit: 'H', rankCard: 2 }, ['s7', 'h3']).error,
    TrickError.THROW_MIXED_SUIT
  );
  // 混花色（不含主牌）
  const r2 = validateLeadPlay({ hand, piecesView: { S: allMineS }, trumpSuit: 'H', rankCard: 2 }, ['s7', 'd9']);
  assert.equal(r2.error, TrickError.THROW_MIXED_SUIT);
  // 资格不成立：四件全未现
  const r3 = validateLeadPlay({ hand, piecesView, trumpSuit: 'H', rankCard: 2 }, ['s7', 's8']);
  assert.equal(r3.ok, false);
  assert.equal(r3.error, TrickError.THROW_NOT_ELIGIBLE);
  assert.match(r3.reason, /还差 ♠A、♠A、♠K、♠K/);
  // 资格成立（四件全在我手）
  const r4 = validateLeadPlay(
    { hand, piecesView: { S: allMineS }, trumpSuit: 'H', rankCard: 2 },
    ['s7', 's8']
  );
  assert.equal(r4.ok, true);
  assert.equal(r4.kind, 'throw');
  assert.equal(r4.playSuit, 'S');
});

test('首家甩牌：甩牌者可以留牌（6 张黑桃只甩 3 张合法）', () => {
  const hand = [
    c('s1', 'S', 9), c('s2', 'S', 8), c('s3', 'S', 7),
    c('s4', 'S', 6), c('s5', 'S', 5), c('s6', 'S', 4),
  ];
  const r = validateLeadPlay(
    { hand, piecesView: { S: allMineS }, trumpSuit: 'H', rankCard: 2 },
    ['s1', 's2', 's3']
  );
  assert.equal(r.ok, true, '只甩 3 张、留 3 张后手是合法的');
});

// ---- validateFollowPlay ----

test('跟牌矩阵（首家甩3张黑桃）：跟牌者持 5 张 / 2 张 / 0 张', () => {
  // 持 5 张黑桃：必须自选 3 张黑桃，不能掺别的
  const hand5 = [c('s1', 'S', 9), c('s2', 'S', 8), c('s3', 'S', 7), c('s4', 'S', 6), c('s5', 'S', 5), c('d1', 'D', 4)];
  const ok5 = validateFollowPlay({ hand: hand5, leadSuit: 'S', leadCount: 3, trumpSuit: 'H', rankCard: 2 }, ['s1', 's2', 's3']);
  assert.equal(ok5.ok, true, '自选 3 张黑桃');
  const bad5 = validateFollowPlay({ hand: hand5, leadSuit: 'S', leadCount: 3, trumpSuit: 'H', rankCard: 2 }, ['s1', 's2', 'd1']);
  assert.equal(bad5.error, TrickError.MUST_FOLLOW_SUIT);
  assert.equal(bad5.reason, '必须跟黑桃');

  // 持 2 张黑桃：必须全部打出 + 垫 1 张（不许留牌）
  const hand2 = [c('s1', 'S', 9), c('s2', 'S', 8), c('d1', 'D', 4), c('d2', 'D', 3), c('h9', 'H', 9)];
  const ok2 = validateFollowPlay({ hand: hand2, leadSuit: 'S', leadCount: 3, trumpSuit: 'H', rankCard: 2 }, ['s1', 's2', 'd1']);
  assert.equal(ok2.ok, true, '黑桃全出 + 1 张补齐');
  const bad2 = validateFollowPlay({ hand: hand2, leadSuit: 'S', leadCount: 3, trumpSuit: 'H', rankCard: 2 }, ['s1', 'd1', 'd2']);
  assert.equal(bad2.error, TrickError.NOT_ENOUGH_SUIT, '留了一张黑桃 → 拒绝');
  assert.equal(bad2.reason, '黑桃不够，需垫 1 张其他牌');

  // 持 0 张黑桃：任意 3 张合法（可 3 张主牌杀，也可全垫/混垫）
  const hand0 = [c('h1', 'H', 9), c('h2', 'H', 7), c('h3', 'H', 5), c('d1', 'D', 4), c('d2', 'D', 3)];
  assert.equal(validateFollowPlay({ hand: hand0, leadSuit: 'S', leadCount: 3, trumpSuit: 'H', rankCard: 2 }, ['h1', 'h2', 'h3']).ok, true, '3 张主牌 = 杀');
  assert.equal(validateFollowPlay({ hand: hand0, leadSuit: 'S', leadCount: 3, trumpSuit: 'H', rankCard: 2 }, ['h1', 'd1', 'd2']).ok, true, '1 主 2 副 = 垫');
  assert.equal(validateFollowPlay({ hand: hand0, leadSuit: 'S', leadCount: 3, trumpSuit: 'H', rankCard: 2 }, ['d1', 'd2', 'h3']).ok, true, '全垫合法');
});

test('跟牌张数必须等于首家张数', () => {
  const hand = [c('s1', 'S', 9), c('s2', 'S', 8), c('d1', 'D', 4)];
  const r = validateFollowPlay({ hand, leadSuit: 'S', leadCount: 3, trumpSuit: 'H', rankCard: 2 }, ['s1', 's2']);
  assert.equal(r.error, TrickError.WRONG_COUNT);
  assert.equal(r.reason, '本轮必须出 3 张牌');
});

test('首家出主牌：必须跟主牌（没有杀的概念）；主牌不够补齐合法', () => {
  const hand = [c('h1', 'H', 9), c('h2', 'H', 7), c('d1', 'D', 4), c('d2', 'D', 3)];
  const bad = validateFollowPlay({ hand, leadSuit: 'TRUMP', leadCount: 1, trumpSuit: 'H', rankCard: 2 }, ['d1']);
  assert.equal(bad.error, TrickError.MUST_FOLLOW_SUIT);
  assert.equal(bad.reason, '必须跟主牌');
  const ok = validateFollowPlay({ hand, leadSuit: 'TRUMP', leadCount: 1, trumpSuit: 'H', rankCard: 2 }, ['h1']);
  assert.equal(ok.ok, true);
  // 无主牌可跟 → 任意垫
  const noTrump = [c('d1', 'D', 4), c('c1', 'C', 8)];
  assert.equal(validateFollowPlay({ hand: noTrump, leadSuit: 'TRUMP', leadCount: 1, trumpSuit: 'H', rankCard: 2 }, ['d1']).ok, true);
});

test('所选牌不在手上 / 空选择 / 重复 id 拒绝', () => {
  const hand = [c('s1', 'S', 9)];
  assert.equal(validateLeadPlay({ hand, piecesView, trumpSuit: 'H', rankCard: 2 }, ['ghost']).error, TrickError.CARDS_NOT_IN_HAND);
  assert.equal(validateLeadPlay({ hand, piecesView, trumpSuit: 'H', rankCard: 2 }, []).error, TrickError.EMPTY_SELECTION);
  assert.equal(validateLeadPlay({ hand: [c('s1', 'S', 9), c('s2', 'S', 8)], piecesView, trumpSuit: 'H', rankCard: 2 }, ['s1', 's1']).error, TrickError.DUPLICATE_CARD_ID);
});

// ---- resolveTrick ----

test('一轮结算·分支A：杀 > 任何副牌；多家杀比最大主牌；补齐牌不参与', () => {
  const plays = [
    { seat: 0, playSuit: 'S', cards: [c('s1', 'S', 14), c('s2', 'S', 14), c('s3', 'S', 13)] }, // 首家甩 3 张黑桃（♠K=10分）
    { seat: 3, cards: [c('d1', 'D', 9), c('d2', 'D', 8), c('d3', 'D', 7)] },                    // 垫（不参与）
    { seat: 2, cards: [c('h1', 'H', 7), c('h2', 'H', 9), c('h3', 'H', 5)] },                    // 杀：3 张主牌，最大 ♥9（♥5=5分）
    { seat: 1, cards: [c('h4', 'H', 10), c('h5', 'H', 11), c('h6', 'H', 3)] },                   // 杀：最大 ♥J，反压（♥10=10分）
  ];
  const r = resolveTrick(plays, ctx);
  assert.equal(r.winnerSeat, 1, '多家杀 → 比各自最大主牌，♥J 最大');
  assert.equal(r.points, 25, '♠K + ♥5 + ♥10 = 25 分');
});

test('一轮结算·分支A：杀赢过任何副牌（即使副牌是满额大牌）', () => {
  const plays = [
    { seat: 0, playSuit: 'S', cards: [c('s1', 'S', 14)] }, // 首家 ♠A
    { seat: 3, cards: [c('h1', 'H', 3)] },                 // 主牌杀（最小主牌也赢）
    { seat: 2, cards: [c('d1', 'D', 4)] },                 // 垫
    { seat: 1, cards: [c('c1', 'C', 14)] },                // 垫
  ];
  const r = resolveTrick(plays, ctx);
  assert.equal(r.winnerSeat, 3, '杀 > 任何副牌');
});

test('一轮结算·分支A：平局归先出者（两张 ♥7、两张副2 均先出者大）', () => {
  // 两家都杀且最大主牌同强度：先出者大
  const killTie = [
    { seat: 0, playSuit: 'S', cards: [c('s1', 'S', 5)] },
    { seat: 3, cards: [c('h1', 'H', 7)] },  // 杀 ♥7
    { seat: 2, cards: [c('h2', 'H', 7)] },  // 杀 ♥7（不同副牌的同点牌）
    { seat: 1, cards: [c('d1', 'D', 8)] },
  ];
  assert.equal(resolveTrick(killTie, ctx).winnerSeat, 3, '同强度杀 → 先出者大');
  // 副2 之间互不比大小：先出者大
  const offRankTie = [
    { seat: 0, playSuit: 'D', cards: [c('d1', 'D', 5)] },
    { seat: 3, cards: [c('s2a', 'S', 2)] }, // 副级牌杀
    { seat: 2, cards: [c('c2b', 'C', 2)] }, // 副级牌杀（同强度）
    { seat: 1, cards: [c('d2', 'D', 9)] },
  ];
  assert.equal(resolveTrick(offRankTie, ctx).winnerSeat, 3, '副2 之间先出者大');
});

test('一轮结算·分支B：首家出主牌，满额跟主牌者比最大主牌，垫牌不参与，平局先出者大', () => {
  const plays = [
    { seat: 0, playSuit: 'TRUMP', cards: [c('h1', 'H', 10)] }, // 首家 ♥10
    { seat: 3, cards: [c('h2', 'H', 14)] },                    // 跟主牌 ♥A → 赢
    { seat: 2, cards: [c('d1', 'D', 13)] },                    // 无主牌，垫（不参与）
    { seat: 1, cards: [c('h3', 'H', 13)] },                    // 跟主牌 ♥K
  ];
  assert.equal(resolveTrick(plays, ctx).winnerSeat, 3);
  const tie = [
    { seat: 0, playSuit: 'TRUMP', cards: [c('h1', 'H', 10)] },
    { seat: 3, cards: [c('h2', 'H', 10)] }, // 同点主牌 → 先出者大
    { seat: 2, cards: [c('d1', 'D', 13)] },
    { seat: 1, cards: [c('h3', 'H', 9)] },
  ];
  assert.equal(resolveTrick(tie, ctx).winnerSeat, 0);
});

test('一轮结算：分数合计正确（K+10+5 = 25）', () => {
  const plays = [
    { seat: 0, playSuit: 'S', cards: [c('s1', 'S', 3)] },
    { seat: 3, cards: [c('s2', 'S', 13)] }, // K = 10
    { seat: 2, cards: [c('s3', 'S', 10)] }, // 10 = 10
    { seat: 1, cards: [c('s4', 'S', 5)] },  // 5 = 5
  ];
  const r = resolveTrick(plays, ctx);
  assert.equal(r.points, 25);
  assert.equal(r.winnerSeat, 3, '♠K 最大');
});

test('不变量：四家手牌数相等校验（不相等直接抛错）', () => {
  const players = [{ hand: [1, 2, 3] }, { hand: [1, 2, 3] }, { hand: [1, 2, 3] }, { hand: [1, 2, 3] }];
  assert.doesNotThrow(() => assertEqualHandCounts(players));
  const bad = [{ hand: [1, 2, 3] }, { hand: [1, 2] }, { hand: [1, 2, 3] }, { hand: [1, 2, 3] }];
  assert.throws(() => assertEqualHandCounts(bad), /手牌数不变量/);
});

test('trickLeader：部分出牌时正确指出当前牌面最大者（与最终结算一致）', () => {
  // 首家甩 3 张黑桃 → 二家垫 → 三家杀 → 四家更大的杀
  const plays = [
    { seat: 0, playSuit: 'S', cards: [c('s1', 'S', 14), c('s2', 'S', 14), c('s3', 'S', 13)] },
    { seat: 3, cards: [c('d1', 'D', 9), c('d2', 'D', 8), c('d3', 'D', 7)] },
    { seat: 2, cards: [c('h1', 'H', 7), c('h2', 'H', 9), c('h3', 'H', 5)] },
    { seat: 1, cards: [c('h4', 'H', 10), c('h5', 'H', 11), c('h6', 'H', 3)] },
  ];
  assert.equal(trickLeader(plays.slice(0, 1), ctx).seat, 0, '首家出牌后领先');
  assert.equal(trickLeader(plays.slice(0, 2), ctx).seat, 0, '垫牌不影响领先');
  assert.equal(trickLeader(plays.slice(0, 3), ctx).seat, 2, '杀者反超');
  assert.equal(trickLeader(plays.slice(0, 4), ctx).seat, 1, '更大的杀再反超');
  assert.equal(trickLeader(plays, ctx).seat, resolveTrick(plays, ctx).winnerSeat, '与结算一致');

  // 副牌跟牌：部分出牌时的比较
  const single = [
    { seat: 0, playSuit: 'S', cards: [c('x1', 'S', 7)] },
    { seat: 3, cards: [c('x2', 'S', 13)] },
  ];
  assert.equal(trickLeader(single.slice(0, 1), ctx).seat, 0);
  assert.equal(trickLeader(single, ctx).seat, 3, '♠K 压过 ♠7');
});
