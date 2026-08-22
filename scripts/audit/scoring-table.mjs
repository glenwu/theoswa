// 审计脚本（不进主干）：把当前计分档位打成表，便于和新规则对照。
import { settleRound } from '../../server/scoring.js';
const row = (label, P, grab) => {
  const r = settleRound({
    defenderTrickPoints: grab ? P - 20 : P, // 撬底时 P 已含底牌与 +20
    kittyPoints: 0, kittyGrab: grab, declarerTeam: 0,
  });
  const who = r.upgradedTeam === 0 ? '庄家方' : '闲家方';
  return `${label.padEnd(12)} ${r.transfer ? '移庄' : '连庄'}  ${r.upgradeCount > 0 ? `${who}升 ${r.upgradeCount} 级` : '双方不升级'}`;
};
console.log('【撬底】P_final = 闲家台面 + 底牌 + 20');
for (const P of [50, 79, 80, 99, 100, 119, 120, 140]) console.log('  ' + row(`P=${P}`, P, true));
console.log('\n【未撬底】P = 闲家台面分');
for (const P of [0, 19, 20, 40, 60, 79, 80, 99, 100, 120, 140]) console.log('  ' + row(`P=${P}`, P, false));
