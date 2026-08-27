import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInitialState, createRoundState, playerBySeat } from '../state.js';
import { applyAction, autoRespondCrossRiver, expireCrossRiverDecision, ErrorCode } from '../actions.js';
import { rebuildPieces, trumpDumpVerdict, pieceStatusesFor } from '../pieces.js';
import { settleRound, finishRound } from '../scoring.js';
import { flipCardForRevealFirst } from '../round.js';
import { settleFallbackTrump } from '../reveal.js';
import { viewerState } from '../viewer.js';
import { mulberry32 } from '../rng.js';
import { saveGame, loadSavedGame, clearSave } from '../persist.js';
import { GameEngine } from '../game-engine.js';

const seeded = () => 0.42;
const c = (id, suit, rank) => ({ id, suit, rank });

// 构造 PLAYING 状态（庄家=座位0、主 ♥、打 2），手牌由调用方填写，然后重建去向表。
// 注意：seeded(0.42) 下座位0 = H、座位2 = T —— 一律用 playerBySeat(state, 0).id 取行动者。
function playingState(trumpSuit = 'H', rankCard = 2) {
  const state = createInitialState(seeded);
  for (const p of state.players) applyAction(state, { type: 'join' }, p.id);
  state.declarerSeat = 0;
  state.round = createRoundState(1, 0);
  state.round.trumpSuit = trumpSuit;
  state.round.rankCard = rankCard;
  state.round.kitty = [];
  state.phase = 'PLAYING';
  state.round.leadSeat = 0;
  state.round.turnSeat = 0;
  return state;
}

const setupTables = state => rebuildPieces(state);
const seat0Id = state => playerBySeat(state, 0).id;
const fillHand = (prefix, suit, n, start = 3) =>
  Array.from({ length: n }, (_, i) => c(`${prefix}${i}`, suit, start + (i % 10)));

// ============ 1. 主牌甩牌 ============

test('主牌甩牌：大鬼×2+小鬼×2+主2×2 全在自己手上 → 6 张成立', () => {
  const state = playingState('H', 2);
  const mine = [
    c('b1', 'JOKER', 16), c('b2', 'JOKER', 16),
    c('s1', 'JOKER', 15), c('s2', 'JOKER', 15),
    c('r1', 'H', 2), c('r2', 'H', 2),
  ];
  playerBySeat(state, 0).hand = mine;
  playerBySeat(state, 1).hand = fillHand('f1', 'S', 25);
  playerBySeat(state, 2).hand = fillHand('f2', 'D', 25);
  playerBySeat(state, 3).hand = fillHand('f3', 'C', 25);
  setupTables(state);

  const verdict = trumpDumpVerdict(
    { trumpCards: state.round.trumpCards, mySeat: 0, trumpSuit: 'H', rankCard: 2 },
    mine
  );
  assert.equal(verdict.eligible, true);

  const res = applyAction(state, { type: 'play', cardIds: mine.map(x => x.id) }, seat0Id(state));
  assert.equal(res.ok, true, res.error?.reason);
  assert.equal(state.round.currentTrick[0].cards.length, 6, '6 张全部打出');
  assert.equal(playerBySeat(state, 0).hand.length, 0);
});

test('主牌甩牌：少一张小鬼且它在别人暗牌里 → 收缩为只出主2，其余收回', () => {
  const state = playingState('H', 2);
  const mine = [
    c('b1', 'JOKER', 16), c('b2', 'JOKER', 16), c('s1', 'JOKER', 15),
    c('r1', 'H', 2), c('r2', 'H', 2),
  ];
  playerBySeat(state, 0).hand = mine;
  playerBySeat(state, 1).hand = [c('s2', 'JOKER', 15), ...fillHand('f1', 'S', 24)];
  playerBySeat(state, 2).hand = fillHand('f2', 'D', 25);
  playerBySeat(state, 3).hand = fillHand('f3', 'C', 25);
  setupTables(state);

  const verdict = trumpDumpVerdict(
    { trumpCards: state.round.trumpCards, mySeat: 0, trumpSuit: 'H', rankCard: 2 },
    mine
  );
  assert.equal(verdict.eligible, false);
  assert.equal(verdict.minCard.rank, 2, '最小一张是主2');

  const res = applyAction(state, { type: 'play', cardIds: mine.map(x => x.id) }, seat0Id(state));
  assert.equal(res.ok, true);
  assert.equal(state.round.currentTrick[0].cards.length, 1, '收缩为 1 张');
  assert.equal(state.round.currentTrick[0].cards[0].id, verdict.minCard.id, '只出最小那张主2');
  assert.equal(playerBySeat(state, 0).hand.length, 4, '其余 4 张收回');
  assert.ok(state.log.some(l => l.text.includes('甩主牌不成立')));
});

test('主牌甩牌：那张小鬼已打出 → 成立', () => {
  const state = playingState('H', 2);
  const mine = [
    c('b1', 'JOKER', 16), c('b2', 'JOKER', 16), c('s1', 'JOKER', 15),
    c('r1', 'H', 2), c('r2', 'H', 2),
  ];
  playerBySeat(state, 0).hand = mine;
  playerBySeat(state, 1).hand = [c('s2', 'JOKER', 15), ...fillHand('f1', 'S', 24)];
  playerBySeat(state, 2).hand = fillHand('f2', 'D', 25);
  playerBySeat(state, 3).hand = fillHand('f3', 'C', 25);
  setupTables(state);
  state.round.trumpCards.find(t => t.cardId === 's2').location = { kind: 'played' };

  const verdict = trumpDumpVerdict(
    { trumpCards: state.round.trumpCards, mySeat: 0, trumpSuit: 'H', rankCard: 2 },
    mine
  );
  assert.equal(verdict.eligible, true);
  const res = applyAction(state, { type: 'play', cardIds: mine.map(x => x.id) }, seat0Id(state));
  assert.equal(res.ok, true);
  assert.equal(state.round.currentTrick[0].cards.length, 5, '5 张全部打出');
});

test('主牌甩牌：最小是副级牌，别人有另一门副级牌（平手）→ 成立', () => {
  const state = playingState('C', 2); // 主梅花打2：♠2 ♥2 ♦2 是副级牌（牌力997，互不比大小）
  const mine = [c('r1', 'S', 2), c('r2', 'H', 2)]; // 甩两张副级牌，最小即副级牌
  playerBySeat(state, 0).hand = mine;
  playerBySeat(state, 1).hand = [c('r3', 'D', 2), ...fillHand('f1', 'S', 24)]; // 另一门副级牌：平手不挡
  playerBySeat(state, 2).hand = fillHand('f2', 'H', 25);
  playerBySeat(state, 3).hand = fillHand('f3', 'D', 25);
  setupTables(state);

  const verdict = trumpDumpVerdict(
    { trumpCards: state.round.trumpCards, mySeat: 0, trumpSuit: 'C', rankCard: 2 },
    mine
  );
  assert.equal(verdict.minCard.rank, 2, '最小一张是副级牌');
  assert.equal(verdict.eligible, true, '平手不算被压过');
  const res = applyAction(state, { type: 'play', cardIds: mine.map(x => x.id) }, seat0Id(state));
  assert.equal(res.ok, true);
  assert.equal(state.round.currentTrick[0].cards.length, 2);
});

test('主牌甩牌：底牌里的更大主牌不挡资格（不在任何人的暗牌里）', () => {
  const state = playingState('H', 2);
  const mine = [c('s1', 'JOKER', 15), c('r1', 'H', 2)]; // 最小主2；大鬼在底牌
  playerBySeat(state, 0).hand = mine;
  state.round.kitty = [c('b1', 'JOKER', 16)];
  playerBySeat(state, 1).hand = fillHand('f1', 'S', 25);
  playerBySeat(state, 2).hand = fillHand('f2', 'D', 25);
  playerBySeat(state, 3).hand = fillHand('f3', 'C', 25);
  setupTables(state);

  const verdict = trumpDumpVerdict(
    { trumpCards: state.round.trumpCards, mySeat: 0, trumpSuit: 'H', rankCard: 2 },
    mine
  );
  assert.equal(verdict.eligible, true, '底牌中的大鬼无法压甩牌，不构成阻挡');
});

test('主牌甩牌跟牌：跟牌方主牌张数不足不影响甩牌者资格，通用跟牌规则补齐', () => {
  const state = playingState('H', 2);
  const mine = [
    c('b1', 'JOKER', 16), c('b2', 'JOKER', 16),
    c('s1', 'JOKER', 15), c('s2', 'JOKER', 15),
    c('r1', 'H', 2), c('r2', 'H', 2),
  ];
  playerBySeat(state, 0).hand = mine;
  playerBySeat(state, 3).hand = [c('t1', 'H', 3), c('t2', 'H', 4), ...fillHand('f3', 'S', 23)];
  playerBySeat(state, 2).hand = fillHand('f2', 'D', 25);
  playerBySeat(state, 1).hand = fillHand('f1', 'C', 25);
  setupTables(state);

  assert.equal(applyAction(state, { type: 'play', cardIds: mine.map(x => x.id) }, seat0Id(state)).ok, true);
  const p3 = playerBySeat(state, 3);
  const follow = p3.hand.slice(0, 6).map(x => x.id);
  assert.equal(applyAction(state, { type: 'play', cardIds: follow }, p3.id).ok, true);
  assert.equal(state.round.currentTrick[1].cards.length, 6, '跟牌张数 = 首家张数');
  const trumpsInFollow = state.round.currentTrick[1].cards.filter(
    x => x.suit === 'H' && x.rank <= 4 && x.rank !== 2
  ).length;
  assert.equal(trumpsInFollow, 2, '2 张主牌全部跟出 + 4 张补齐');
});

// ============ 1b. 三主过河 ============

// CROSS_RIVER 状态：庄家=座位0，主♥打2。
// 座位0：2 主 + 23 副（含 ♠A 件）；座位2（对家）：3 主 + 22 副（含 ♠K 件）；
// 座位1：20 主（不符）；座位3：25 副。
function crossRiverState() {
  const state = playingState('H', 2);
  state.phase = 'CROSS_RIVER';
  state.round.crossRiver.decideDeadline = Date.now() + 60000;
  playerBySeat(state, 0).hand = [
    c('t0a', 'H', 3), c('t0b', 'H', 4), c('p0a', 'S', 14),
    ...fillHand('f0', 'S', 22),
  ];
  playerBySeat(state, 2).hand = [
    c('t2a', 'H', 5), c('t2b', 'H', 6), c('t2c', 'H', 7), c('p2a', 'S', 13),
    ...fillHand('f2', 'D', 21),
  ];
  playerBySeat(state, 1).hand = [
    c('t1a', 'H', 8), c('t1b', 'H', 9), c('t1c', 'H', 10), c('t1d', 'H', 11), c('t1e', 'H', 12),
    ...fillHand('t1x', 'H', 15, 4),
    ...fillHand('f1', 'C', 5),
  ];
  playerBySeat(state, 3).hand = fillHand('f3', 'C', 25);
  setupTables(state);
  return state;
}

test('过河阶段隔离：CROSS_RIVER 阶段不能换底', () => {
  const state = crossRiverState();
  const res = applyAction(state, { type: 'buryKitty', cardIds: [] }, seat0Id(state));
  assert.equal(res.error.code, ErrorCode.WRONG_PHASE);
});

test('过河：发起 → 对家回 3 副 → 交换成功，双方手牌数不变，播报公开', () => {
  const state = crossRiverState();
  const p0 = playerBySeat(state, 0);
  const p2 = playerBySeat(state, 2);
  const res = applyAction(state, { type: 'initiateCrossRiver', cardIds: ['t0a', 't0b', 'p0a'] }, p0.id);
  assert.equal(res.ok, true, res.error?.reason);
  assert.equal(state.round.crossRiver.active.length, 1);
  assert.equal(state.round.crossRiver.active[0].toSeat, 2);

  const back = ['p2a', p2.hand.find(x => x.suit === 'D').id, p2.hand.filter(x => x.suit === 'D')[1].id];
  assert.equal(applyAction(state, { type: 'respondCrossRiver', cardIds: back }, p2.id).ok, true);

  assert.equal(p0.hand.length, 25, '发起者手牌数不变');
  assert.equal(p2.hand.length, 25, '对家手牌数不变');
  assert.equal(p0.hand.filter(x => x.id === 't0a').length, 0, '主牌已交出');
  assert.equal(p2.hand.filter(x => x.id === 't0a').length, 1, '对家收到主牌');
  assert.equal(p0.hand.filter(x => x.id === 'p2a').length, 1, '发起者收到对家副牌');
  assert.equal(state.round.crossRiver.doneTeams.includes(0), true, '队0已过河');
  assert.equal(state.round.declarerCrossedRiver, true, '庄家触发了过河');
  assert.ok(state.log.some(l => l.text.includes('三主过河（3 张换 3 张）')), '公开播报');
  for (const p of state.players) assert.equal(p.hand.length, 25, '四家手牌数相等');
});

test('过河：同队两人都符合 → 先点先得，第二人收到拒绝', () => {
  const state = crossRiverState();
  const p0 = playerBySeat(state, 0);
  const p2 = playerBySeat(state, 2);
  assert.equal(applyAction(state, { type: 'initiateCrossRiver', cardIds: ['t0a', 't0b', 'p0a'] }, p0.id).ok, true);
  const res2 = applyAction(state, { type: 'initiateCrossRiver', cardIds: ['t2a', 't2b', 't2c'] }, p2.id);
  assert.equal(res2.error.code, ErrorCode.CROSS_RIVER_TEAM_ACTIVE, '同队先点先得');
});

test('过河：对家 30 秒不回 → 系统自动挑最小 3 张副牌完成', () => {
  const state = crossRiverState();
  const p0 = playerBySeat(state, 0);
  assert.equal(applyAction(state, { type: 'initiateCrossRiver', cardIds: ['t0a', 't0b', 'p0a'] }, p0.id).ok, true);
  autoRespondCrossRiver(state, 0);
  assert.equal(state.round.crossRiver.active.length, 0, '自动完成');
  assert.equal(state.round.crossRiver.doneTeams.includes(0), true);
  const p2 = playerBySeat(state, 2);
  assert.equal(p2.hand.filter(x => x.id === 't0a').length, 1, '对家收到主牌');
  assert.ok(state.log.some(l => l.text.includes('系统自动挑出 3 张最小副牌')));
});

test('过河：件去向表同步更新；对手视角仍是未现（不泄密）', () => {
  const state = crossRiverState();
  const p0 = playerBySeat(state, 0);
  const p2 = playerBySeat(state, 2);
  assert.equal(applyAction(state, { type: 'initiateCrossRiver', cardIds: ['t0a', 't0b', 'p0a'] }, p0.id).ok, true);
  const backIds = ['p2a', p2.hand.find(x => x.suit === 'D').id, p2.hand.filter(x => x.suit === 'D')[1].id];
  assert.equal(applyAction(state, { type: 'respondCrossRiver', cardIds: backIds }, p2.id).ok, true);

  const viewFor = seat => pieceStatusesFor(state.round.pieces, 'H', seat).S;
  const opponent = viewFor(1);
  assert.equal(opponent.filter(x => x.status === 'unseen').length, 2, '对手视角两张件都未现');
  assert.equal(viewFor(0).filter(x => x.status === 'mine').length, 1, '发起者只看到 ♠K 在我手上');
  assert.equal(viewFor(2).filter(x => x.status === 'mine').length, 1, '对家只看到 ♠A 在我手上');
  const view = viewerState(state, playerBySeat(state, 1).id);
  const json = JSON.stringify(view);
  assert.ok(!json.includes('"p0a"') && !json.includes('"p2a"'), '对手 payload 不含换手件的 cardId');
});

test('过河：对家副牌不足 3 张 → 不可发起（按钮禁用依据）', () => {
  const state = crossRiverState();
  playerBySeat(state, 2).hand = [c('t2a', 'H', 5), c('t2b', 'H', 6), c('d1', 'D', 3), c('d2', 'D', 4)];
  const res = applyAction(state, { type: 'initiateCrossRiver', cardIds: ['t0a', 't0b', 'p0a'] }, seat0Id(state));
  assert.equal(res.error.code, ErrorCode.CROSS_RIVER_NOT_ELIGIBLE, '对家副牌不足 3 张不可发起');
});

test('过河：跳过 → 无人可过河时自动进入 PLAYING（庄家先出）', () => {
  const state = crossRiverState();
  // 对家改成 4 主 + 3 副（副牌够 → 座位0 仍可发起；座位2 主牌 >3 不再候选）
  playerBySeat(state, 2).hand = [
    c('t2a', 'H', 5), c('t2b', 'H', 6), c('t2c', 'H', 7), c('t2d', 'H', 8),
    c('d1', 'D', 3), c('d2', 'D', 4), c('d3', 'D', 5),
  ];
  // 座位1（座位3 的对家）副牌收到 2 张 → 座位3 不再是候选
  playerBySeat(state, 1).hand = [
    ...fillHand('t1x', 'H', 23, 4),
    c('g1', 'C', 3), c('g2', 'C', 4),
  ];
  assert.equal(applyAction(state, { type: 'skipCrossRiver' }, seat0Id(state)).ok, true);
  assert.equal(state.phase, 'PLAYING', '唯一候选跳过 → 直接出牌');
  assert.equal(state.round.turnSeat, state.declarerSeat, '庄家先出');
});

test('过河：决定窗口结束自动跳过未行动候选 → PLAYING（引擎计时路径）', () => {
  const state = crossRiverState();
  expireCrossRiverDecision(state);
  assert.equal(state.phase, 'PLAYING');
  assert.ok(state.round.crossRiver.passedSeats.length >= 1, '未行动的候选被标记跳过');
});

test('过河：存档往返保留过河中间状态（active/giveCardIds/phase），重启可恢复', () => {
  const state = crossRiverState();
  const p0 = playerBySeat(state, 0);
  assert.equal(applyAction(state, { type: 'initiateCrossRiver', cardIds: ['t0a', 't0b', 'p0a'] }, p0.id).ok, true);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'csu7-'));
  const file = path.join(dir, 'save.json');
  saveGame(state, file);
  const loaded = loadSavedGame(file);
  clearSave(file);
  assert.equal(loaded.phase, 'CROSS_RIVER');
  assert.equal(loaded.round.crossRiver.active.length, 1);
  assert.deepEqual(loaded.round.crossRiver.active[0].giveCardIds, ['t0a', 't0b', 'p0a'], '发起者选的牌已存档');
  assert.equal(loaded.round.crossRiver.doneTeams.length, 0);
});

test('过河：引擎计时（对家回牌超时自动完成 + 决定窗口结束自动跳过）', async () => {
  const state = crossRiverState();
  state.round.crossRiver.decideDeadline = Date.now() + 200;
  const p0 = playerBySeat(state, 0);
  const engine = new GameEngine({
    state,
    timings: { crossRiverPickMs: 60 },
    broadcast: () => {},
  });
  assert.equal(engine.applyAction({ type: 'initiateCrossRiver', cardIds: ['t0a', 't0b', 'p0a'] }, p0.id).ok, true);
  await new Promise(r => setTimeout(r, 350));
  assert.equal(state.round.crossRiver.active.length, 0, '对家 60ms 不回 → 系统自动完成');
  assert.equal(state.round.crossRiver.doneTeams.includes(0), true, '队0 已完成过河');
  assert.equal(state.phase, 'PLAYING', '决定窗口结束、无人再发起 → 进入出牌');
  engine.clearTimers();
});

// ============ 1b. 撬底主牌额外升级惩罚 ============

test('过河惩罚：庄家触发过河 + 被撬底 + 底牌 8 张主牌 + P_final=90 → 闲家升 9 级', () => {
  const r = settleRound({
    defenderTrickPoints: 90, kittyPoints: 0, kittyGrab: true, declarerTeam: 0,
    declarerCrossedRiver: true, trumpsInKitty: 8,
  });
  assert.equal(r.defenderPoints, 90, '撬底不再加 20');
  assert.equal(r.upgradeCount, 9, '1（正常，撬底够80）+ 8（过河惩罚）');
  assert.equal(r.crossRiverPenalty, 8);
});

test('过河惩罚：庄家埋 8 张主牌但未触发过河 → 无额外惩罚（只剩撬底本身的 1 级）', () => {
  const r = settleRound({
    defenderTrickPoints: 90, kittyPoints: 0, kittyGrab: true, declarerTeam: 0,
    declarerCrossedRiver: false, trumpsInKitty: 8,
  });
  assert.equal(r.crossRiverPenalty, 0, '没触发过河就不该有惩罚');
  assert.equal(r.upgradeCount, 1, 'P_final=90 撬底本身 1 级，底里 8 张主牌一级都不加');
});

test('过河惩罚：庄家触发过河但未被撬底 → 无额外惩罚', () => {
  const r = settleRound({
    defenderTrickPoints: 70, kittyPoints: 20, kittyGrab: false, declarerTeam: 0,
    declarerCrossedRiver: true, trumpsInKitty: 8,
  });
  assert.equal(r.transfer, false, '连庄');
  assert.equal(r.crossRiverPenalty, 0);
});

test('过河惩罚：finishRound 集成（底牌 8 主无分、被撬底、庄家过河）→ 摘要含惩罚且级别叠加', () => {
  const state = playingState('H', 2);
  state.round.kitty = [3, 4, 6, 7, 8, 9, 11, 12].map((r, i) => c(`k${i}`, 'H', r)); // 8 张主牌 0 分
  state.round.declarerCrossedRiver = true;
  state.round.defenderTrickPoints = 90; // 撬底不再加 20，台面就得是 90 才有 P_final=90
  state.round.runAwayPoints = 200 - 90; // 底牌 0 分 → 台面 + 跑掉 = 200，守恒
  state.round.trickHistory = [{ trickNo: 1, winnerSeat: 1, plays: [], points: 0 }]; // 闲家赢 → 撬底
  const summary = finishRound(state);
  assert.equal(summary.kittyGrab, true);
  assert.equal(summary.crossRiverPenalty, 8);
  // 期望值写死，不要把实现公式抄进断言 —— 那样实现改了断言跟着改，等于没测
  assert.equal(summary.upgradeCount, 9, 'P_final=90：撬底正常 1 级 + 过河惩罚 8 级');
  assert.equal(summary.conservationOk, true);
});

// ============ 2. 最后一轮自动打出 ============

test('最后一轮自动打出：四家各 1 张（无论第几轮）→ 逐张自动打出并结算，无卡死', async () => {
  const state = playingState('H', 2);
  state.round.trickHistory = [{ trickNo: 18, winnerSeat: 0, plays: [], points: 0 }]; // 甩牌让轮数不固定
  playerBySeat(state, 0).hand = [c('p0', 'S', 3)];
  playerBySeat(state, 3).hand = [c('p3', 'S', 4)];
  playerBySeat(state, 2).hand = [c('p2', 'S', 5)];
  playerBySeat(state, 1).hand = [c('p1', 'S', 6)];
  state.round.kitty = [c('k0', 'C', 5)];
  state.round.lastTrick = { trickNo: 18, plays: [], winnerSeat: 0, points: 0 };
  state.round.settleDeadline = Date.now() + 40;
  state.round.leadSeat = 0;
  state.round.turnSeat = 0;

  const engine = new GameEngine({
    state,
    // finalSettleMs 也要压小：最后一墩现在会单独停 5 秒给人看牌（Glen），
    // 不设的话这条测试要等满 5 秒才进结算。
    timings: { settleMs: 40, finalSettleMs: 40, autoLastMs: 15, scoringMs: 60000 },
    broadcast: () => {},
  });
  try {
    await new Promise(r => setTimeout(r, 400));
    assert.equal(state.phase, 'SCORING', '自动打完最后一轮并进入结算');
    // 局中只剩 2 条记录（上一轮 + 自动打完的最后一轮）；能结算说明判据是“四家各 1 张”，不是第 25 轮
    assert.equal(state.round.trickHistory.length, 2, '自动补上最后一轮');
    assert.equal(state.round.trickHistory[1].plays.length, 4, '最后一轮四家出齐');
    assert.ok(state.players.every(p => p.hand.length === 0));
    assert.ok(!state.log.some(l => l.text.includes('自动打最后一轮失败')));
  } finally {
    engine.clearTimers();
  }
});

// ============ 6. 「妮！」彩蛋 ============

test('妮彩蛋：打出 Q 用独立随机源掷骰（0.39 触发 / 0.4 不触发），多张 Q 只掷一次', () => {
  const state = playingState('H', 2);
  state.rng = mulberry32(42);
  const rngStateBefore = state.rng.state();
  playerBySeat(state, 0).hand = [c('q1', 'H', 12), c('q2', 'H', 12)]; // 两张主花色 Q（同为 TRUMP 可甩）
  playerBySeat(state, 3).hand = fillHand('f3', 'C', 25);
  playerBySeat(state, 2).hand = fillHand('f2', 'C', 25);
  playerBySeat(state, 1).hand = fillHand('f1', 'C', 25);
  setupTables(state);

  let rolls = 0;
  state.niiRandom = () => { rolls += 1; return 0.39; };
  // 甩两张 Q：现在【不触发】—— 彩蛋只认单张 Q（甩牌是一手战术，不是「打了个 Q」）
  assert.equal(applyAction(state, { type: 'play', cardIds: ['q1', 'q2'] }, seat0Id(state)).ok, true);
  assert.equal(state.round.currentTrick[0].nii, undefined, '甩牌里夹着 Q 不触发');
  assert.equal(rolls, 0, '不满足条件时根本不掷骰');
  assert.equal(state.rng.state(), rngStateBefore, '彩蛋掷骰不推进发牌种子流（SEED 复现不受影响）');
});

test('妮彩蛋：未命中（0.4）不触发；非 Q 不掷骰', () => {
  const state = playingState('H', 2);
  playerBySeat(state, 0).hand = [c('q1', 'S', 12)];
  playerBySeat(state, 3).hand = fillHand('f3', 'C', 25);
  playerBySeat(state, 2).hand = fillHand('f2', 'C', 25);
  playerBySeat(state, 1).hand = fillHand('f1', 'C', 25);
  setupTables(state);
  let rolls = 0;
  state.niiRandom = () => { rolls += 1; return 0.4; };
  assert.equal(applyAction(state, { type: 'play', cardIds: ['q1'] }, seat0Id(state)).ok, true);
  assert.notEqual(state.round.currentTrick[0].nii, true);
  assert.equal(rolls, 1);

  const state2 = playingState('H', 2);
  playerBySeat(state2, 0).hand = [c('n1', 'S', 5)];
  playerBySeat(state2, 3).hand = fillHand('g3', 'C', 25);
  playerBySeat(state2, 2).hand = fillHand('g2', 'C', 25);
  playerBySeat(state2, 1).hand = fillHand('g1', 'C', 25);
  setupTables(state2);
  let rolls2 = 0;
  state2.niiRandom = () => { rolls2 += 1; return 0; };
  assert.equal(applyAction(state2, { type: 'play', cardIds: ['n1'] }, seat0Id(state2)).ok, true);
  assert.equal(rolls2, 0, '非 Q 不掷骰');
});

// ============ 8. 关键节点大图数据 ============

test('翻牌定起揭人：每次翻牌写入 flipEvent（大小王作废也要逐张展示）', () => {
  const state = createInitialState(seeded);
  for (const p of state.players) applyAction(state, { type: 'join' }, p.id);
  for (const p of state.players) applyAction(state, { type: 'confirmSeat' }, p.id);
  for (const p of state.players) applyAction(state, { type: 'ready' }, p.id);
  applyAction(state, { type: 'claimFlipper' }, 'T');
  const first = flipCardForRevealFirst(state);
  assert.equal(state.round.flipEvent.kind, first.kind);
  assert.deepEqual(state.round.flipEvent.card, first.card);
  if (first.kind === 'JOKER') {
    assert.equal(state.round.flipEvent.starterSeat, undefined, '作废王不定起揭人');
    const view = viewerState(state, 'T');
    assert.equal(view.round.flipEvent.kind, 'JOKER', '作废翻牌大图数据公开');
    const second = flipCardForRevealFirst(state);
    assert.equal(state.round.flipEvent.kind, second.kind);
  } else {
    assert.equal(typeof state.round.flipEvent.starterSeat, 'number');
    const view = viewerState(state, 'T');
    assert.equal(view.round.flipEvent.starterSeat, state.round.flipEvent.starterSeat);
  }
});

test('亮主：trumpEvent 记录亮出的级牌与是否第一局（成为庄家）', () => {
  const state = createInitialState(seeded);
  for (const p of state.players) applyAction(state, { type: 'join' }, p.id);
  state.declarerSeat = null;
  state.round = createRoundState(1, null);
  state.round.rankCard = 2;
  state.phase = 'REVEALING';
  playerBySeat(state, 0).hand.push(c('r1', 'H', 2));
  assert.equal(applyAction(state, { type: 'declareTrump', cardId: 'r1' }, seat0Id(state)).ok, true);
  assert.equal(state.round.trumpEvent.card.id, 'r1');
  assert.equal(state.round.trumpEvent.wasFirstRound, true, '第一局亮主者成为庄家');
  assert.equal(state.declarerSeat, 0);
  const view = viewerState(state, seat0Id(state));
  assert.equal(view.round.trumpEvent.wasFirstRound, true);
});

test('揭底定主：fallbackTrumpCard 标出定主的那张底牌（级牌优先，否则首张非王）', () => {
  const state = createInitialState(seeded);
  state.declarerSeat = 0;
  state.round = createRoundState(1, 0);
  state.round.rankCard = 2;
  state.phase = 'FALLBACK_TRUMP';
  state.round.fallbackRevealed = [
    c('k0', 'JOKER', 16), c('k1', 'S', 9), c('k2', 'D', 7), c('k3', 'S', 4),
    c('k4', 'C', 2), c('k5', 'H', 10), c('k6', 'S', 5), c('k7', 'JOKER', 15),
  ];
  settleFallbackTrump(state);
  assert.equal(state.round.trumpSuit, 'C', '级牌 ♣2 定主');
  assert.equal(state.round.fallbackTrumpCard.id, 'k4', '定主的是那张级牌');
  const view = viewerState(state, 'T');
  assert.equal(view.round.fallbackTrumpCard.id, 'k4');
});