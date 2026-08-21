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

// 规则变更（Glen 2026-08-20）：撬底且够 80 分，档位整体 +1 级
test('撬底：台面 80 分 → P=80，移庄，闲家升 1 级', () => {
  const r = settleRound({ defenderTrickPoints: 80, kittyPoints: 0, kittyGrab: true, declarerTeam: 0 });
  assert.equal(r.defenderPoints, 80, '撬底不再额外加 20');
  assert.equal(r.transfer, true);
  assert.equal(r.upgradeCount, 1, '撬底够 80 分至少升 1 级（未撬底的 80 分才是 0 级）');
});

test('撬底但不够 80：台面 50 分 → 移庄，双方均不升级（庄家不得升2级）', () => {
  const r = settleRound({ defenderTrickPoints: 50, kittyPoints: 0, kittyGrab: true, declarerTeam: 0 });
  assert.equal(r.defenderPoints, 50);
  assert.equal(r.transfer, true, '撬底无条件移庄');
  assert.equal(r.upgradeCount, 0, '庄家不得因守住而升 2 级');
});

test('撬底：台面 100 分 → P=100，移庄，闲家升 2 级', () => {
  const r = settleRound({ defenderTrickPoints: 100, kittyPoints: 0, kittyGrab: true, declarerTeam: 1 });
  assert.equal(r.defenderPoints, 100);
  assert.equal(r.transfer, true);
  assert.equal(r.upgradedTeam, 0, '闲家队');
  assert.equal(r.upgradeCount, 2);
});

// 撬底档位比未撬底整体高一级 —— 这个差值是规则的核心，单独钉死
test('撬底档位 = 未撬底档位 + 1（同一 P 下逐档对照）', () => {
  for (const P of [80, 95, 100, 119, 120, 140, 160]) {
    const grabbed = settleRound({ defenderTrickPoints: P, kittyPoints: 0, kittyGrab: true, declarerTeam: 0 });
    const plain = settleRound({ defenderTrickPoints: P, kittyPoints: 0, kittyGrab: false, declarerTeam: 0 });
    assert.equal(grabbed.defenderPoints, P, `撬底 P_final 应为 ${P}`);
    assert.equal(grabbed.upgradeCount, plain.upgradeCount + 1, `P=${P}：撬底应比未撬底多 1 级`);
    assert.equal(grabbed.transfer, true);
    assert.equal(plain.transfer, true);
  }
});

// Glen 2026-08-20 逐档确认的撬底档位，写死钉住（不要改成公式，公式错了断言会跟着错）
test('撬底档位逐档：80→1、100→2、120→3、140→4、160→5、180→6、200→7', () => {
  const tiers = [[80, 1], [100, 2], [120, 3], [140, 4], [160, 5], [180, 6], [200, 7]];
  for (const [P, level] of tiers) {
    const r = settleRound({ defenderTrickPoints: P, kittyPoints: 0, kittyGrab: true, declarerTeam: 0 });
    assert.equal(r.defenderPoints, P);
    assert.equal(r.upgradeCount, level, `P_final=${P} 应升 ${level} 级`);
  }
});

test('撬底档位：每档 20 分内级数不变（档位边界不飘）', () => {
  for (const [lo, hi, level] of [[80, 99, 1], [100, 119, 2], [140, 159, 4], [180, 199, 6]]) {
    for (const P of [lo, lo + 7, hi]) {
      const r = settleRound({ defenderTrickPoints: P, kittyPoints: 0, kittyGrab: true, declarerTeam: 0 });
      assert.equal(r.upgradeCount, level, `P_final=${P} 落在 ${lo}-${hi} 档，应升 ${level} 级`);
    }
  }
});

// 理论上限：全场总分就是 200，闲家通吃时 P_final 恰好 200 —— 档位表正好收口在 7 级
test('撬底档位上限：P_final=200（闲家通吃）→ 7 级；不可能再高', () => {
  const r = settleRound({ defenderTrickPoints: 180, kittyPoints: 20, kittyGrab: true, declarerTeam: 0 });
  assert.equal(r.defenderPoints, 200, '台面 180 + 底牌 20 = 200，不再有 +20');
  assert.equal(r.upgradeCount, 7);
  assert.equal(r.transfer, true);
});

test('撬底但 P_final < 80 → 仍然只移庄、双方不升级（+1 级不适用）', () => {
  for (const P of [20, 50, 79]) {
    const r = settleRound({ defenderTrickPoints: P, kittyPoints: 0, kittyGrab: true, declarerTeam: 0 });
    assert.equal(r.defenderPoints, P);
    assert.equal(r.transfer, true, '撬底无条件移庄');
    assert.equal(r.upgradeCount, 0, `P=${P} 不够 80，不升级`);
  }
});

test('底牌 K+5（15 分）撬底 → P = 台面分 + 底牌分（无 +20）', () => {
  const r = settleRound({ defenderTrickPoints: 40, kittyPoints: 15, kittyGrab: true, declarerTeam: 0 });
  assert.equal(r.defenderPoints, 55, '40 + 15，不再有 +20');
  assert.equal(r.transfer, true);
  assert.equal(r.upgradeCount, 0, 'P_final<80 不升级');
});

test('撬底且 P_final 足够高：底牌分也参与升级档位', () => {
  // 台面 80 + 底牌 15 = 95 → 移庄，闲家升 floor(15/20)+1 = 1
  const r1 = settleRound({ defenderTrickPoints: 80, kittyPoints: 15, kittyGrab: true, declarerTeam: 0 });
  assert.equal(r1.defenderPoints, 95);
  assert.equal(r1.upgradeCount, 1);
  // 台面 90 + 底牌 15 = 105 → 升 floor(25/20)+1 = 2 级
  const r2 = settleRound({ defenderTrickPoints: 90, kittyPoints: 15, kittyGrab: true, declarerTeam: 0 });
  assert.equal(r2.defenderPoints, 105);
  assert.equal(r2.upgradeCount, 2);
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
