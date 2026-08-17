import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  settleRound,
  nextDeclarerSeat,
  checkConservation,
  kittyPointsOf,
} from '../scoring.js';
import { applyUpgrades } from '../level.js';

test('验收6：闲家 0 分 → 庄家升 5 级且连庄', () => {
  const r = settleRound({ defenderTrickPoints: 0, kittyPoints: 0, kittyGrab: false, declarerTeam: 0 });
  assert.deepEqual(r, { defenderPoints: 0, transfer: false, upgradedTeam: 0, upgradeCount: 5, crossRiverPenalty: 0 });
});

test('庄家守住分档：1-19 升4、20-39 升3、40-59 升2、60-79 升1（连庄）', () => {
  assert.equal(settleRound({ defenderTrickPoints: 15, kittyPoints: 0, kittyGrab: false, declarerTeam: 1 }).upgradeCount, 4);
  assert.equal(settleRound({ defenderTrickPoints: 20, kittyPoints: 0, kittyGrab: false, declarerTeam: 1 }).upgradeCount, 3);
  assert.equal(settleRound({ defenderTrickPoints: 55, kittyPoints: 0, kittyGrab: false, declarerTeam: 1 }).upgradeCount, 2);
  assert.equal(settleRound({ defenderTrickPoints: 75, kittyPoints: 0, kittyGrab: false, declarerTeam: 1 }).upgradeCount, 1);
  const r = settleRound({ defenderTrickPoints: 75, kittyPoints: 0, kittyGrab: false, declarerTeam: 1 });
  assert.equal(r.transfer, false);
  assert.equal(r.upgradedTeam, 1);
});

test('验收7：闲家 105 分 → 移庄且闲家升 1 级', () => {
  const r = settleRound({ defenderTrickPoints: 105, kittyPoints: 0, kittyGrab: false, declarerTeam: 0 });
  assert.deepEqual(r, { defenderPoints: 105, transfer: true, upgradedTeam: 1, upgradeCount: 1, crossRiverPenalty: 0 });
});

test('移庄升级表：80-99 升0、100-119 升1、120-139 升2、140-159 升3、200 升6', () => {
  assert.equal(settleRound({ defenderTrickPoints: 90, kittyPoints: 0, kittyGrab: false, declarerTeam: 0 }).upgradeCount, 0);
  assert.equal(settleRound({ defenderTrickPoints: 100, kittyPoints: 0, kittyGrab: false, declarerTeam: 0 }).upgradeCount, 1);
  assert.equal(settleRound({ defenderTrickPoints: 120, kittyPoints: 0, kittyGrab: false, declarerTeam: 0 }).upgradeCount, 2);
  assert.equal(settleRound({ defenderTrickPoints: 140, kittyPoints: 0, kittyGrab: false, declarerTeam: 0 }).upgradeCount, 3);
  assert.equal(settleRound({ defenderTrickPoints: 200, kittyPoints: 0, kittyGrab: false, declarerTeam: 0 }).upgradeCount, 6);
});

test('验收11：闲家 60 分且撬底 → P=80，移庄，双方均不升级', () => {
  const r = settleRound({ defenderTrickPoints: 60, kittyPoints: 0, kittyGrab: true, declarerTeam: 0 });
  assert.equal(r.defenderPoints, 80);
  assert.equal(r.transfer, true);
  assert.equal(r.upgradeCount, 0);
});

test('验收12：闲家 30 分且撬底（底牌无分）→ P=50，移庄，双方均不升级（庄家不得升2级）', () => {
  const r = settleRound({ defenderTrickPoints: 30, kittyPoints: 0, kittyGrab: true, declarerTeam: 0 });
  assert.equal(r.defenderPoints, 50);
  assert.equal(r.transfer, true, '撬底无条件移庄');
  assert.equal(r.upgradeCount, 0, '庄家不得因守住而升 2 级');
});

test('验收13：闲家 80 分且撬底 → P=100，移庄，闲家升 1 级', () => {
  const r = settleRound({ defenderTrickPoints: 80, kittyPoints: 0, kittyGrab: true, declarerTeam: 1 });
  assert.equal(r.defenderPoints, 100);
  assert.equal(r.transfer, true);
  assert.equal(r.upgradedTeam, 0, '闲家队');
  assert.equal(r.upgradeCount, 1);
});

test('验收5：底牌 K+5（15 分），闲家撬底 → P = 台面分 + 15 + 20', () => {
  const r = settleRound({ defenderTrickPoints: 40, kittyPoints: 15, kittyGrab: true, declarerTeam: 0 });
  assert.equal(r.defenderPoints, 75, '40 + 15 + 20');
  assert.equal(r.transfer, true);
  assert.equal(r.upgradeCount, 0, 'P_final<80 不升级');
});

test('撬底且 P_final 足够高：底牌分也参与升级档位', () => {
  // 台面 60 + 底牌 15 + 20 = 95 → 移庄，闲家升 floor(15/20)=0
  const r1 = settleRound({ defenderTrickPoints: 60, kittyPoints: 15, kittyGrab: true, declarerTeam: 0 });
  assert.equal(r1.defenderPoints, 95);
  assert.equal(r1.upgradeCount, 0);
  // 台面 70 + 底牌 15 + 20 = 105 → 升 1 级
  const r2 = settleRound({ defenderTrickPoints: 70, kittyPoints: 15, kittyGrab: true, declarerTeam: 0 });
  assert.equal(r2.defenderPoints, 105);
  assert.equal(r2.upgradeCount, 1);
});

test('庄家轮转：连庄 → 对家（座位+2）；移庄 → 下家（座位+3，验收21/22）', () => {
  assert.equal(nextDeclarerSeat(0, false), 2);
  assert.equal(nextDeclarerSeat(1, false), 3);
  assert.equal(nextDeclarerSeat(0, true), 3);
  assert.equal(nextDeclarerSeat(2, true), 1);
});

test('验收23/24/25：级别推进与胜负判定（一次升多级可跨到胜利）', () => {
  // 打 A(12) 升 1 → 13（第二圈的 2，级牌回到 2，游戏继续）
  const r1 = applyUpgrades([12, 0], 0, 1);
  assert.equal(r1.levels[0], 13);
  assert.equal(r1.winningTeam, null);
  // 13 升 1 → 14 获胜
  const r2 = applyUpgrades([13, 0], 0, 1);
  assert.equal(r2.levels[0], 14);
  assert.equal(r2.winningTeam, 0);
  // 打 K(11) 升 3 → 14 当场获胜
  const r3 = applyUpgrades([11, 0], 0, 3);
  assert.equal(r3.levels[0], 14);
  assert.equal(r3.winningTeam, 0);
});

test('守恒校验：只认台面分（200 = 闲家台面 + 庄家跑掉 + 底牌）', () => {
  assert.equal(checkConservation(80, 105, 15), true);
  assert.equal(checkConservation(100, 100, 0), true);
  assert.equal(checkConservation(0, 0, 200), true);
  assert.equal(checkConservation(80, 100, 15), false, '少 5 分即失败');
  assert.equal(checkConservation(100, 100, 20), false, '多 20 分即失败（撬底加成绝不混入守恒）');
});

test('底牌分数计算', () => {
  const kitty = [
    { id: 'a', suit: 'S', rank: 13 },
    { id: 'b', suit: 'H', rank: 5 },
    { id: 'c', suit: 'D', rank: 10 },
    { id: 'd', suit: 'C', rank: 3 },
  ];
  assert.equal(kittyPointsOf(kitty), 25);
});
