// Glen 2026-09-09 第三条：
//   「如果对手两家都没主牌的情况，经常还会把主牌都打得很光，其实这些都已经是
//     大牌了，不必要再打，就看副牌怎么走就行，自己主牌打光，别人甩牌就毙不到了。」
//
// 口径：领牌那一刻，两个对手都【已知断主】（此前某个主牌墩他没跟主），
// 而我还在领主牌。断主是公开信息，不用偷看手牌。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf } from '../../server/cards.js';

const N = Number(process.env.N ?? 200);
let leads = 0, bothVoid = 0, stillTrump = 0, wentBare = 0;

for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: 4200 + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  const { trumpSuit, rankCard } = round;
  const ps = c => playSuitOf(c, trumpSuit, rankCard);

  // 到第 ti 墩为止，seat 是不是已知断主
  const voidByTrump = (seat, ti) => {
    for (let k = 0; k < ti; k++) {
      const t = hist[k];
      if (t.leadSuit !== 'TRUMP') continue;
      const play = (t.plays ?? []).find(p => p.seat === seat);
      if (!play) continue;
      const need = (t.plays?.[0]?.cards ?? []).length;
      if ((play.cards ?? []).filter(c => ps(c) === 'TRUMP').length < need) return true;
    }
    return false;
  };

  hist.forEach((t, ti) => {
    const lead = t.plays?.[0];
    if (!lead) return;
    leads += 1;
    const opps = [0, 1, 2, 3].filter(s => s % 2 !== lead.seat % 2);
    if (!opps.every(s => voidByTrump(s, ti))) return;
    bothVoid += 1;
    if (t.leadSuit !== 'TRUMP') return;
    stillTrump += 1;
    // 这一领之后自己的主还剩几张（还原：往后打出的主）
    let left = 0;
    for (let k = ti + 1; k < hist.length; k++)
      for (const p of hist[k].plays ?? [])
        if (p.seat === lead.seat) left += (p.cards ?? []).filter(c => ps(c) === 'TRUMP').length;
    if (left === 0) wentBare += 1;
  });
}
const pct = (a, b) => b ? `${(a * 100 / b).toFixed(1)}%` : '--';
console.log(`${N} 局：领牌 ${leads} 次，其中【两个对手都已知断主】的 ${bothVoid} 次`);
console.log(`  这时候还在领主牌      ${stillTrump}\t${pct(stillTrump, bothVoid)}`);
console.log(`    领完自己主就光了    ${wentBare}\t${pct(wentBare, stillTrump)}`);
