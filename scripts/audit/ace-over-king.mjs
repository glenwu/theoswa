// Glen 2026-08-30：「场上如果有 K，经常会不管后果用 A 去砍，导致给对手甩 8 支
//   10 支的情况，自己那时还有这门牌。」
//
// 口径：每一次跟牌打出副牌 A，而这一墩里【对手打过这门的 K】。
// 再看三件事：
//   · 这一手是不是把该门的件【凑齐】了（打完之后一支未现的件都没有 → 对手可甩）
//   · 对手这门估计还有多长（他甩得出去多少张）
//   · 我当时这门还有没有别的牌（有 = 躲得掉，不是被逼的）
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf, cardPoints } from '../../server/cards.js';

const N = Number(process.env.N ?? 200);
const BASE = Number(process.env.BASE ?? 4200);
let aceOverK = 0, completed = 0, hadOthers = 0, bad = 0;
const lenBuckets = new Map();
let thrownAfter = 0, thrownLen = 0;

for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: BASE + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  const { trumpSuit, rankCard } = round;
  const ps = c => playSuitOf(c, trumpSuit, rankCard);
  const isPiece = c => ps(c) !== 'TRUMP' && (c.rank === 14 || c.rank === 13) && c.rank !== rankCard;
  const pieceTotal = [14, 13].filter(r => r !== rankCard).length * 2;

  hist.forEach((t, ti) => {
    const plays = t.plays ?? [];
    plays.forEach((play, pi) => {
      const ace = (play.cards ?? []).find(c => isPiece(c) && c.rank === 14);
      if (!ace) return;
      const suit = ps(ace);
      // ⚠️ 只数【对手先打了 K、我跟在后面用 A 去砍】。
      // 第一版把 pi 之后出现的 K 也算进来了 —— 那是我【领】A 去碰他的 K
      //（Glen 自己要的那条打法），方向相反，混在一起会把好牌算成坏牌。
      const oppK = plays.slice(0, pi).some(p =>
        (p.seat % 2) !== (play.seat % 2) &&
        (p.cards ?? []).some(c => isPiece(c) && c.rank === 13 && ps(c) === suit));
      if (!oppK) return;
      aceOverK += 1;

      // 打完这一墩之后，这门还有几支件没现
      let seen = 0;
      for (let k = 0; k <= ti; k++)
        for (const p of hist[k].plays ?? [])
          for (const x of p.cards ?? []) if (ps(x) === suit && isPiece(x)) seen += 1;
      const done = seen >= pieceTotal;
      if (done) completed += 1;

      // 我这门当时还有别的牌吗（这一墩之后我还打出过这门的牌）
      let mineLater = 0;
      for (let k = ti + 1; k < hist.length; k++)
        for (const p of hist[k].plays ?? [])
          if (p.seat === play.seat) for (const x of p.cards ?? []) if (ps(x) === suit) mineLater += 1;
      if (mineLater > 0) hadOthers += 1;

      // 对手之后真的甩了这门吗，甩了几张
      let threw = 0;
      for (let k = ti + 1; k < hist.length; k++) {
        const l = hist[k].plays?.[0];
        if (!l || (hist[k].leadSeat % 2) === (play.seat % 2)) continue;
        if ((l.cards ?? []).length >= 2 && ps(l.cards[0]) === suit) threw = Math.max(threw, l.cards.length);
      }
      if (threw >= 2) { thrownAfter += 1; thrownLen += threw; lenBuckets.set(threw, (lenBuckets.get(threw) ?? 0) + 1); }
      if (done && mineLater > 0) bad += 1;
    });
  });
}
const pct = (a, b) => b ? `${(a * 100 / b).toFixed(1)}%` : '--';
console.log(`${N} 局：对手在这一墩打了 K、我用同门 A 去砍 —— 共 ${aceOverK} 次`);
console.log(`  这一手把该门的件凑齐了（对手从此可甩）  ${completed}\t${pct(completed, aceOverK)}`);
console.log(`  我当时这门还有别的牌（不是被逼的）      ${hadOthers}\t${pct(hadOthers, aceOverK)}`);
console.log(`  ★ 两条都中（Glen 说的那种）             ${bad}\t${pct(bad, aceOverK)}`);
console.log(`  之后对手真的甩了这门                    ${thrownAfter}\t${pct(thrownAfter, aceOverK)}`);
if (thrownAfter) console.log(`    平均甩 ${(thrownLen / thrownAfter).toFixed(1)} 张，分布：` +
  [...lenBuckets.entries()].sort((a,b)=>a[0]-b[0]).map(([k,v])=>`${k}张:${v}`).join('  '));
