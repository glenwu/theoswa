import { cardPoints, playSuitOf } from './cards.js';
import { pushLog, playerBySeat } from './state.js';
import { nextSeat, oppositeSeat } from './rotation.js';
import { applyUpgrades } from './level.js';
import { SUIT_NAMES } from './constants.js';

// 算分、撬底、移庄升级 —— 全部纯函数。
// 全局只统计闲家得分：庄家不吃分，庄家赢下的分作废跑掉。

export const TEAM_NAMES = ['金队', '青队'];

// 底牌分数
export function kittyPointsOf(kitty) {
  return kitty.reduce((sum, c) => sum + cardPoints(c), 0);
}

// 撬底 = 最后一轮（第 25 轮）的赢家是闲家方（与该轮有没有分无关）
export function kittyGrabOf(state) {
  const r = state.round;
  const last = r.trickHistory[r.trickHistory.length - 1];
  if (!last) throw new Error('kittyGrab 判定需要已打完的局');
  return last.winnerSeat % 2 !== state.declarerSeat % 2;
}

// 全局分数守恒：只认台面分。P_final 里的 +20 与撬底底牌加成不参与守恒。
export function checkConservation(defenderTrickPoints, runAwayPoints, kittyPoints) {
  return defenderTrickPoints + runAwayPoints + kittyPoints === 200;
}

// 计分升级（权威公式，一字不差）：
//   P_final = defenderTrickPoints + (kittyGrab ? kittyPoints + 20 : 0)
//   撬底 → 无条件移庄；P_final≥80 闲家升 floor((P_final-80)/20) + 1，
//          否则（P_final<80）双方都不升（庄家不得因守住而升）
//   未撬底且 P≥80 → 移庄，闲家升 floor((P-80)/20)
//   未撬底且 P<80 → 连庄，庄家升：P=0 → 5 级；1~79 → ceil((80-P)/20)
//
// ⚠️ 撬底档位比未撬底整体高一级（80→1、100→2、120→3），这是刻意的：
// 撬底本身就是战果，够 80 分就该有实质回报，不能和"刚好守到 80"同价。
// 未撬底那一列保持 80→0、100→1、120→2 不变。
// 规则由 Glen 于 2026-08-20 裁定，覆盖规则文档 §6.9 原表（文档待同步）。
//
// 阶段7 三主过河惩罚（仅庄家、仅触发过河、仅被撬底时生效）：
//   底牌中每有一张主牌，闲家再额外加升一级。独立叠加在正常级数之上，
//   即使正常部分为 0 也照加（庄家未触发过河时绝不生效——埋主牌进底本身不受罚）。
export function settleRound({
  defenderTrickPoints,
  kittyPoints,
  kittyGrab,
  declarerTeam,
  declarerCrossedRiver = false,
  trumpsInKitty = 0,
}) {
  const P_final = defenderTrickPoints + (kittyGrab ? kittyPoints + 20 : 0);

  if (kittyGrab) {
    const crossRiverPenalty = declarerCrossedRiver ? trumpsInKitty : 0;
    return {
      defenderPoints: P_final,
      transfer: true,
      upgradedTeam: 1 - declarerTeam,
      // 撬底且够 80 分 → 档位 +1 级（80→1、100→2、120→3…）
      upgradeCount: (P_final >= 80 ? Math.floor((P_final - 80) / 20) + 1 : 0) + crossRiverPenalty,
      crossRiverPenalty,
    };
  }
  if (defenderTrickPoints >= 80) {
    return {
      defenderPoints: P_final,
      transfer: true,
      upgradedTeam: 1 - declarerTeam,
      upgradeCount: Math.floor((defenderTrickPoints - 80) / 20),
      crossRiverPenalty: 0,
    };
  }
  return {
    defenderPoints: P_final,
    transfer: false,
    upgradedTeam: declarerTeam,
    upgradeCount: defenderTrickPoints === 0 ? 5 : Math.ceil((80 - defenderTrickPoints) / 20),
    crossRiverPenalty: 0,
  };
}

// 庄家轮转：
// - 连庄（transfer=false）：庄权留在本队，传给本局庄家的对家（座位+2）
// - 移庄（transfer=true）：传给本局庄家的下家（逆时针下一位，座位+3）
export function nextDeclarerSeat(declarerSeat, transfer) {
  return transfer ? nextSeat(declarerSeat) : oppositeSeat(declarerSeat);
}

// 局末结算（打完 25 轮后调用）：
// 计算底牌分/撬底/最终 P，更新级别与庄家，生成 RoundSummary 并入 rounds，
// 转移到 ROUND_END（或某队获胜 → GAME_OVER）。
export function finishRound(state) {
  const r = state.round;
  const declarerTeam = state.declarerSeat % 2;
  const kittyPoints = kittyPointsOf(r.kitty);
  const kittyGrab = kittyGrabOf(state);
  r.kittyPoints = kittyPoints;

  const result = settleRound({
    defenderTrickPoints: r.defenderTrickPoints,
    kittyPoints,
    kittyGrab,
    declarerTeam,
    declarerCrossedRiver: r.declarerCrossedRiver === true,
    // 三主过河惩罚：底牌中的主牌张数（大小王/主级牌/副级牌/主花色牌都算）
    trumpsInKitty: r.kitty.filter(
      c => playSuitOf(c, r.trumpSuit, r.rankCard) === 'TRUMP'
    ).length,
  });
  r.defenderPoints = result.defenderPoints;

  const { levels, winningTeam } = applyUpgrades(state.teamLevels, result.upgradedTeam, result.upgradeCount);
  state.teamLevels = levels;

  const nextDeclarer = nextDeclarerSeat(state.declarerSeat, result.transfer);
  const conservationOk = checkConservation(r.defenderTrickPoints, r.runAwayPoints, kittyPoints);

  const summary = {
    roundNumber: r.roundNumber,
    declarerSeat: state.declarerSeat,
    trumpSuit: r.trumpSuit,
    rankCard: r.rankCard,
    defenderTrickPoints: r.defenderTrickPoints,
    runAwayPoints: r.runAwayPoints,
    kittyPoints,
    kittyGrab,
    defenderPoints: result.defenderPoints,
    transfer: result.transfer,
    upgradedTeam: result.upgradedTeam,
    upgradeCount: result.upgradeCount,
    crossRiverPenalty: result.crossRiverPenalty ?? 0,
    nextDeclarerSeat: nextDeclarer,
    conservationOk,
  };
  state.rounds.push(summary);

  const nextName = playerBySeat(state, nextDeclarer).nickname;
  const upgradeText =
    result.upgradeCount > 0
      ? `${TEAM_NAMES[result.upgradedTeam]}升 ${result.upgradeCount} 级`
      : '双方都不升级';
  pushLog(
    state,
    `第 ${r.roundNumber} 局结束：闲家台面 ${r.defenderTrickPoints} 分、庄家跑掉 ${r.runAwayPoints} 分、底牌 ${kittyPoints} 分${
      kittyGrab ? '，被撬底 +20' : ''
    }。最终 P=${result.defenderPoints}，${result.transfer ? '移庄' : '连庄'}，${upgradeText}。下一局 ${nextName} 做庄。`
  );
  if (result.crossRiverPenalty > 0) {
    pushLog(state, `三主过河惩罚：庄家触发过河且被撬底，底牌 ${result.crossRiverPenalty} 张主牌 → 闲家额外 +${result.crossRiverPenalty} 级。`);
  }
  if (!conservationOk) {
    pushLog(state, '警告：分数守恒校验失败（defenderTrickPoints + runAwayPoints + kittyPoints ≠ 200）！');
  }

  state.declarerSeat = nextDeclarer;
  if (winningTeam !== null) {
    state.gameWinnerTeam = winningTeam;
    state.phase = 'GAME_OVER';
    pushLog(state, `🏆 游戏结束：${TEAM_NAMES[winningTeam]}获胜！`);
  } else {
    state.phase = 'SCORING';
  }
  return summary;
}

export { SUIT_NAMES };
