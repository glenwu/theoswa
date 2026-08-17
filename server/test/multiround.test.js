import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInitialState, playerBySeat } from '../state.js';
import { applyAction, expireCrossRiverDecision } from '../actions.js';
import { flipCardForRevealFirst, drawOneCard, completeDeal } from '../round.js';
import { settleNoTrump } from '../flow.js';
import { settleFallbackTrump } from '../reveal.js';
import { playSuitOf, cardStrength } from '../cards.js';
import { rankOfLevel } from '../level.js';
import { settleRound, nextDeclarerSeat, kittyGrabOf } from '../scoring.js';
import { applyUpgrades } from '../level.js';

const seeded = () => 0.42;
const c = (id, suit, rank) => ({ id, suit, rank });

function readyAll(state) {
  for (const p of state.players) applyAction(state, { type: 'ready' }, p.id);
}

function botCards(hand, lead, ctx) {
  const suitOf = x => playSuitOf(x, ctx.trumpSuit, ctx.rankCard);
  const bySuit = s => hand.filter(x => suitOf(x) === s);
  const lowest = (cards, n) =>
    [...cards].sort((a, b) => cardStrength(a, ctx) - cardStrength(b, ctx)).slice(0, n);
  if (!lead) {
    const nonTrump = hand.filter(x => suitOf(x) !== 'TRUMP');
    return [lowest(nonTrump.length ? nonTrump : hand, 1)[0]];
  }
  const N = lead.cards.length;
  const suitCards = bySuit(lead.playSuit);
  if (suitCards.length >= N) return lowest(suitCards, N);
  if (suitCards.length > 0) {
    return [...lowest(suitCards, suitCards.length), ...lowest(hand.filter(x => !suitCards.includes(x)), N - suitCards.length)];
  }
  const trumps = bySuit('TRUMP');
  if (trumps.length >= N) return lowest(trumps, N);
  return lowest(hand, N);
}

// 用纯动作打完一整局（模拟引擎的阶段推进，返回 'DONE' 或 'VOID'）
function playFullRound(state) {
  // 每局开头：全员准备 → beginRound 整体重建 RoundState
  const seatsBefore = { ...state.seatsByPlayer };
  const levelsBefore = [...state.teamLevels];
  readyAll(state);
  // 断言 1：跨局重建后的累加类字段均为初始值
  const r = state.round;
  assert.ok(r, 'RoundState 已重建');
  assert.equal(r.defenderTrickPoints, 0);
  assert.equal(r.runAwayPoints, 0);
  assert.equal(r.trickHistory.length, 0);
  assert.equal(r.currentTrick.length, 0);
  assert.equal(r.pieces.length, 0);
  assert.equal(r.kittyPoints, 0);
  assert.equal(r.lastTrick, null);
  assert.equal(r.drawnCount, 0);
  assert.ok(r.deck.length === 108 || r.deck.length === 100);
  assert.deepEqual(state.seatsByPlayer, seatsBefore, '座位跨局保留');
  assert.deepEqual(state.teamLevels, levelsBefore, '级别跨局保留');

  if (state.phase === 'REVEAL_FIRST') {
    // 仅庄家未定时可达（第一局/流局后）
    assert.equal(state.declarerSeat, null);
    applyAction(state, { type: 'claimFlipper' }, 'T');
    let guard = 0;
    while (state.phase === 'REVEAL_FIRST' && guard++ < 5) {
      flipCardForRevealFirst(state);
    }
  } else {
    // 第二局起：直进 REVEALING，庄家先揭，级牌 = 新庄家方升级后的级别
    assert.notEqual(state.declarerSeat, null, '庄家已定 → 直进 REVEALING');
    assert.equal(state.round.revealTurnSeat, state.declarerSeat, '固定由庄家先揭');
    assert.equal(
      state.round.rankCard,
      rankOfLevel(state.teamLevels[state.declarerSeat % 2]),
      '级牌 = 新庄家方当前级别'
    );
  }

  // 揭牌：摸到级牌立即亮主
  while (state.phase === 'REVEALING') {
    if (state.round.drawnCount >= 100) {
      const outcome = settleNoTrump(state);
      if (outcome === 'VOID') return 'VOID';
      state.round.fallbackRevealed = [...state.round.kitty];
      settleFallbackTrump(state);
      break;
    }
    const seat = state.round.revealTurnSeat;
    const card = drawOneCard(state, seat);
    if (card.rank === state.round.rankCard) {
      const holder = playerBySeat(state, seat);
      applyAction(state, { type: 'declareTrump', cardId: card.id }, holder.id);
      break;
    }
  }
  completeDeal(state); // → KITTY_EXCHANGE（庄家 33 张，底牌已并入）
  const declarer = playerBySeat(state, state.declarerSeat);
  assert.equal(declarer.hand.length, 33, '换底前庄家 33 张');
  const buried = declarer.hand.slice(0, 8).map(x => x.id);
  assert.equal(applyAction(state, { type: 'buryKitty', cardIds: buried }, declarer.id).ok, true);
  // 换底后进入 CROSS_RIVER：模拟引擎决定窗口结束（bot 全部跳过过河）→ PLAYING
  expireCrossRiverDecision(state);

  // 出牌：bot 打完整局
  const ctx = { trumpSuit: state.round.trumpSuit, rankCard: state.round.rankCard };
  let guard = 0;
  while (guard++ < 300) {
    if (state.phase === 'DOMINANCE') {
      // 碾压判定命中 → 确认收尾
      const res = applyAction(state, { type: 'confirmDominance' }, 'T');
      assert.equal(res.ok, true);
      break;
    }
    if (state.phase !== 'PLAYING') break;
    state.round.lastTrick = null; // 模拟引擎收牌停留结束
    for (let i = 0; i < 4; i++) {
      const p = playerBySeat(state, state.round.turnSeat);
      const lead = state.round.currentTrick[0] ?? null;
      const cards = botCards(p.hand, lead, ctx);
      const res = applyAction(state, { type: 'play', cardIds: cards.map(x => x.id) }, p.id);
      assert.equal(res.ok, true, `第${state.rounds.length + 1}局 bot 出牌失败：${res.error?.reason}`);
    }
  }
  // 模拟引擎：SCORING → ROUND_END → READY_CHECK（round 置空，下一局整体重建）
  if (state.phase === 'SCORING') state.phase = 'ROUND_END';
  if (state.phase === 'ROUND_END') {
    state.phase = 'READY_CHECK';
    for (const p of state.players) p.ready = false;
    state.round = null;
  }
  return 'DONE';
}

test('多局 bot 连打至 GAME_OVER：每局守恒、无跨局污染、摘要完整', () => {
  const state = createInitialState(seeded);
  for (const p of state.players) applyAction(state, { type: 'join' }, p.id);
  for (const p of state.players) applyAction(state, { type: 'confirmSeat' }, p.id);

  let guard = 0;
  while (state.phase !== 'GAME_OVER' && guard++ < 30) {
    const outcome = playFullRound(state);
    if (outcome === 'VOID') {
      assert.equal(state.phase, 'READY_CHECK', '流局仅发生在第一局');
      assert.equal(state.declarerSeat, null);
      continue;
    }
    const summary = state.rounds[state.rounds.length - 1];
    assert.equal(summary.conservationOk, true, `第 ${summary.roundNumber} 局守恒（200 分）`);
    // 轮转一致性：下一局庄家 = 摘要中的 nextDeclarerSeat
    if (state.phase !== 'GAME_OVER') {
      assert.equal(state.declarerSeat, summary.nextDeclarerSeat);
      assert.equal(state.round, null, '局间无残留 RoundState');
    }
  }
  assert.equal(state.phase, 'GAME_OVER', '达到胜负（30 局内）');
  assert.ok(state.gameWinnerTeam !== null, '有获胜队');
  assert.ok(state.rounds.length >= 1);
});

test('连庄守住升2级：下一局级牌用升级后的级别，庄家是本局庄家的对家（验收21变体）', () => {
  const state = createInitialState(seeded);
  for (const p of state.players) applyAction(state, { type: 'join' }, p.id);
  for (const p of state.players) applyAction(state, { type: 'confirmSeat' }, p.id);
  state.declarerSeat = 0;
  state.teamLevels = [3, 0]; // 庄家队打 5（index 3）
  state.phase = 'READY_CHECK';

  // 模拟上局结算：闲家 45 分 → 庄家升 2 级（40-59 档），连庄
  const result = settleRound({ defenderTrickPoints: 45, kittyPoints: 0, kittyGrab: false, declarerTeam: 0 });
  assert.equal(result.upgradeCount, 2);
  assert.equal(result.transfer, false);
  const next = nextDeclarerSeat(0, false);
  assert.equal(next, 2, '连庄：庄权传给本局庄家的对家（座位+2）');
  const { levels } = applyUpgrades(state.teamLevels, result.upgradedTeam, result.upgradeCount);
  state.teamLevels = levels;
  state.declarerSeat = next;
  state.round = null;
  state.rounds.push({ roundNumber: 1 });

  readyAll(state);
  assert.equal(state.phase, 'REVEALING', '第二局不出现抢按揭牌，直进揭牌');
  assert.equal(state.round.roundNumber, 2, '局号 +1');
  assert.equal(state.round.revealTurnSeat, 2, '新庄家先揭');
  assert.equal(state.round.rankCard, 7, '打 5 升 2 级 → 打 7（用升级后的级别）');

  // 第二局无人亮主 → 揭底定主，庄家不变
  while (state.round.drawnCount < 100) drawOneCard(state, state.round.revealTurnSeat);
  assert.equal(settleNoTrump(state), 'FALLBACK');
  assert.equal(state.phase, 'FALLBACK_TRUMP');
  assert.equal(state.declarerSeat, 2, '庄家不变');
  state.round.fallbackRevealed = [...state.round.kitty];
  settleFallbackTrump(state);
  assert.equal(state.phase, 'DEALING');
});

test('移庄：新庄家为本局庄家的下家（验收22）', () => {
  assert.equal(nextDeclarerSeat(0, true), 3);
  assert.equal(nextDeclarerSeat(3, true), 2);
  // 下家必是对方队伍的人：座位 0(队0) → 3(队1)
  assert.notEqual(nextDeclarerSeat(0, true) % 2, 0 % 2);
});

test('撬底判定：最后一轮赢家是闲家方才算（与该轮分数无关）', () => {
  const state = createInitialState(seeded);
  state.declarerSeat = 0;
  state.round = {
    trickHistory: [{ trickNo: 25, winnerSeat: 3 }], // 3%2=1 ≠ 0 → 闲家赢
  };
  assert.equal(kittyGrabOf(state), true);
  state.round.trickHistory = [{ trickNo: 25, winnerSeat: 2 }]; // 队0 → 庄家方
  assert.equal(kittyGrabOf(state), false);
});
