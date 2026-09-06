// Glen 2026-09-06：「BOT 把鬼吊完，但剩最后一支是副牌给我们保底的情况，
//   优化一下，大牌主还是需要留到最后撬底。」
//
// 最后一墩定保底/撬底。手上还剩副牌就意味着最后那一墩赢不了 ——
// 顶端的主牌（鬼）本来就是【专门用来赢最后一墩】的那张牌，提前吊出去等于把它作废。
//
// 口径：每一局每一家，看他【最后一张牌】是主是副，以及他有没有在中途领过鬼。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf } from '../../server/cards.js';

const N = Number(process.env.N ?? 200);
const BASE = Number(process.env.BASE ?? 4200);

let jokerLeads = 0, jokerLeadEndsSide = 0, jokerLeadLostLast = 0;
const after = new Map();
let comboLeads = 0, comboEndsSide = 0, comboLostLast = 0, comboBottomLost = 0;
let hands = 0, endsSide = 0;
const leadWhen = new Map();

for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: BASE + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (hist.length < 6) continue;
  const { trumpSuit, rankCard } = round;
  const ps = c => playSuitOf(c, trumpSuit, rankCard);
  const last = hist[hist.length - 1];

  for (const seat of [0, 1, 2, 3]) {
    const finalPlay = (last.plays ?? []).find(p => p.seat === seat);
    if (!finalPlay) continue;
    hands += 1;
    const finalIsSide = (finalPlay.cards ?? []).every(c => ps(c) !== 'TRUMP');
    if (finalIsSide) endsSide += 1;

    // 中途【领】过鬼吗（最后两墩之外）
    let led = null;
    hist.forEach((t, ti) => {
      const lead = t.plays?.[0];
      if (!lead || lead.seat !== seat) return;
      if (!(lead.cards ?? []).some(c => c.rank === 15 || c.rank === 16)) return;
      const fromEnd = hist.length - ti;
      if (fromEnd <= 2) return;                    // 最后两墩领鬼是对的，不算
      if (led === null || fromEnd > led) led = fromEnd;
    });
    if (led === null) continue;
    jokerLeads += 1;
    // 【保底/撬底的鬼组合】—— 领那一手之前手上大小鬼都还在（Glen 说的那个牌型）。
    // 手牌还原：从那一墩起他打出的所有牌。
    const li = hist.length - led;
    const restJokers = new Set();
    for (let k = li; k < hist.length; k++)
      for (const q of hist[k].plays ?? [])
        if (q.seat === seat)
          for (const x of q.cards ?? []) if (x.rank === 15 || x.rank === 16) restJokers.add(x.rank);
    // 领完这一手之后，手上还剩几张主 / 几张副（还原：从下一墩起他打出的牌）
    let trumpAfter = 0, sideAfter = 0;
    for (let k = li + 1; k < hist.length; k++)
      for (const q of hist[k].plays ?? [])
        if (q.seat === seat)
          for (const x of q.cards ?? []) (ps(x) === 'TRUMP' ? trumpAfter++ : sideAfter++);
    const shape = `主${trumpAfter}/副${sideAfter}`;
    if (!after.has(shape)) after.set(shape, [0, 0]);
    after.get(shape)[0] += 1;
    if (finalIsSide) after.get(shape)[1] += 1;
    if (restJokers.has(15) && restJokers.has(16)) {
      comboLeads += 1;
      if (finalIsSide) comboEndsSide += 1;
      if (last.winnerSeat !== seat) comboLostLast += 1;
      // 他这一方在最后一墩输了 = 保底/撬底这件事没做成
      if ((last.winnerSeat % 2) !== (seat % 2)) comboBottomLost += 1;
    }
    leadWhen.set(led, (leadWhen.get(led) ?? 0) + 1);
    if (finalIsSide) jokerLeadEndsSide += 1;
    if (last.winnerSeat !== seat) jokerLeadLostLast += 1;
  }
}
const pct = (a, b) => b ? `${(a * 100 / b).toFixed(1)}%` : '--';
console.log(`${N} 局 · ${hands} 手：最后一张是副牌的 ${endsSide}\t${pct(endsSide, hands)}`);
console.log(`\n中途（最后两墩之前）领鬼出去的 ${jokerLeads} 手：`);
console.log(`  这些手最后一张还是副牌  ${jokerLeadEndsSide}\t${pct(jokerLeadEndsSide, jokerLeads)}`);
console.log(`  最后一墩没赢下来        ${jokerLeadLostLast}\t${pct(jokerLeadLostLast, jokerLeads)}`);
console.log(`\n其中【领之前大小鬼都还在手上】的 ${comboLeads} 手（Glen 说的那个牌型）：`);
console.log(`  最后一张还是副牌        ${comboEndsSide}\t${pct(comboEndsSide, comboLeads)}`);
console.log(`  最后一墩自己没赢        ${comboLostLast}\t${pct(comboLostLast, comboLeads)}`);
console.log(`  最后一墩【我方】没赢    ${comboBottomLost}\t${pct(comboBottomLost, comboLeads)}`);
console.log('\n  领完这一手之后手上剩的牌型 → 最后一张是副牌的比例：');
for (const [k, v] of [...after.entries()].sort((a, b) => b[1][0] - a[1][0]))
  console.log(`    ${k.padEnd(10)}\t${v[0]} 次，其中最后一张是副牌 ${v[1]}`);
console.log('\n  领鬼领在倒数第几墩：');
for (const [k, v] of [...leadWhen.entries()].sort((a, b) => a[0] - b[0]))
  console.log(`    倒数第 ${String(k).padStart(2)} 墩\t${v}`);
