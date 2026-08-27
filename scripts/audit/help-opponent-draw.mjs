// Glen：「吊主也一样，如果对方要吊主吊大牌出来让自己保底，或是吊短主牌可以让
//   自己的甩牌别人毙不到，那我方记着不能帮对方吊主；当然也有例外，就是自己的
//   主牌碾压式的强，可以反吊回去。」
//
// 口径：每一次领主牌，问一句「上一次领主牌的是不是对手」。是 → 记一次「帮对手吊」。
// 再分栏看我自己的主牌是不是碾压（手上主牌 ≥9 张且握着顶端那一张没现的更大牌）。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf } from '../../server/cards.js';

const N = Number(process.env.N ?? 200);
let trumpLeads = 0, followed = 0, crushing = 0;
for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: 4200 + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  const { trumpSuit, rankCard } = round;
  const ps = c => playSuitOf(c, trumpSuit, rankCard);
  hist.forEach((t, ti) => {
    if (t.leadSuit !== 'TRUMP') return;
    trumpLeads += 1;
    let prev = null;
    for (let k = ti - 1; k >= 0; k--) if (hist[k].leadSuit === 'TRUMP') { prev = hist[k]; break; }
    if (!prev || (prev.leadSeat % 2) === (t.leadSeat % 2)) return;
    followed += 1;
    let mine = 0;
    for (let k = ti; k < hist.length; k++)
      for (const p of hist[k].plays ?? [])
        if (p.seat === t.leadSeat) for (const x of p.cards ?? []) if (ps(x) === 'TRUMP') mine += 1;
    if (mine >= 9) crushing += 1;
  });
}
console.log(`${N} 局：领主牌共 ${trumpLeads} 次`);
console.log(`  上一次领主的是对手（= 接着帮他吊）  ${followed}\t${(followed*100/trumpLeads).toFixed(1)}%`);
console.log(`    其中自己主牌 ≥9 张（算碾压，可以反吊）  ${crushing}`);
console.log(`    其余 ${followed - crushing} 次是纯帮对手吊主`);
