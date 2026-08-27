// Glen：「不得以或是砍大分出的话，就要再吊对手可以甩花色。」
// 也就是说：被迫在某门交出了件之后，要主动去领这门，把他的甩牌张数压短。
//
// 口径：找出「我方在对手求的那门交出了件」的墩，然后看这一家（或队友）
// 之后【第一次领牌】领的是不是这门（前提是手上还有这门的牌）。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf } from '../../server/cards.js';

const N = Number(process.env.N ?? 200);
let cases = 0, ledIt = 0, hadNoCards = 0, ledElse = 0, neverLed = 0;

for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: 4200 + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  const { trumpSuit, rankCard } = round;
  const ps = c => playSuitOf(c, trumpSuit, rankCard);
  const isPiece = c => ps(c) !== 'TRUMP' && (c.rank === 14 || c.rank === 13) && c.rank !== rankCard;

  hist.forEach((t, ti) => {
    const lead = t.plays?.[0];
    if (!lead || t.leadSuit === 'TRUMP') return;
    const a = lead.cards ?? [];
    if (a.length !== 1 || isPiece(a[0]) || !(a[0].rank <= 5 || a[0].rank === 10)) return;
    const suit = t.leadSuit;
    for (const play of (t.plays ?? []).slice(1)) {
      if ((play.seat % 2) === (lead.seat % 2)) continue;       // 只看对手求、我方给
      if (!(play.cards ?? []).some(isPiece)) continue;
      cases += 1;
      // 我方之后第一次领牌
      let found = null;
      for (let k = ti + 1; k < hist.length; k++) {
        if ((hist[k].leadSeat % 2) !== (play.seat % 2)) continue;
        found = hist[k]; break;
      }
      if (!found) { neverLed += 1; break; }
      // 领牌那一刻他手上还有这门吗
      let has = false;
      const idx = hist.indexOf(found);
      for (let k = idx; k < hist.length; k++)
        for (const p of hist[k].plays ?? [])
          if (p.seat === found.leadSeat) for (const x of p.cards ?? []) if (ps(x) === suit) has = true;
      if (!has) { hadNoCards += 1; break; }
      if (found.leadSuit === suit) ledIt += 1; else ledElse += 1;
      break;
    }
  });
}
const pct = n => cases ? `${(n * 100 / cases).toFixed(1)}%` : '--';
console.log(`${N} 局：「对手求件、我方交出了件」共 ${cases} 次`);
console.log(`  之后我方第一次领牌就领这门（Glen 要的）  ${ledIt}\t${pct(ledIt)}`);
console.log(`  领了别的门                                ${ledElse}\t${pct(ledElse)}`);
console.log(`  这门已经打空，没得领                      ${hadNoCards}\t${pct(hadNoCards)}`);
console.log(`  之后我方再没领过牌                        ${neverLed}\t${pct(neverLed)}`);
