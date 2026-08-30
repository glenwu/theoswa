// Glen 2026-08-30 的「用件去碰件」：
//   「如果求那门牌已经出到没剩几张，外边还有 8 张 10 张左右的样子，如果被求的对手
//     赔分，5 分 10 分等，这个时候可以用自己手里的件去碰他的件。比如对方还有一个 K，
//     在求的过程突然看到他赔一个 10 出来，计算出局外部的这门牌也不多了，
//     这时候比如自己有 A，可以用 A 去把 K 碰出来。」
//
// 口径：每一次【领出副牌的件】，看它是不是踩在这两个前提上（外面剩 ≤10 张 +
// 对手在这门赔过分），以及这一碰有没有把对手的件撞出来。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf, cardPoints } from '../../server/cards.js';

const N = Number(process.env.N ?? 200);
const BASE = Number(process.env.BASE ?? 4200);
let leadPiece = 0, onCue = 0, bumped = 0, onCueBumped = 0;

for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: BASE + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  const { trumpSuit, rankCard } = round;
  const ps = c => playSuitOf(c, trumpSuit, rankCard);
  const isPiece = c => ps(c) !== 'TRUMP' && (c.rank === 14 || c.rank === 13) && c.rank !== rankCard;

  hist.forEach((t, ti) => {
    const lead = t.plays?.[0];
    const cards = lead?.cards ?? [];
    if (cards.length !== 1 || !isPiece(cards[0])) return;
    const suit = ps(cards[0]);
    leadPiece += 1;

    // 前提①：这门外面还剩几张（24 − 已出 − 领牌人手上剩的）
    let played = 0;
    for (let k = 0; k < ti; k++)
      for (const p of hist[k].plays ?? [])
        for (const x of p.cards ?? []) if (ps(x) === suit) played += 1;
    let mine = 0;
    for (let k = ti; k < hist.length; k++)
      for (const p of hist[k].plays ?? [])
        if (p.seat === lead.seat) for (const x of p.cards ?? []) if (ps(x) === suit) mine += 1;
    const outstanding = Math.max(0, 24 - played - mine);

    // 前提②：对手在这门赔过分
    let dumped = false;
    for (let k = 0; k < ti && !dumped; k++) {
      const winnerTeam = hist[k].winnerSeat % 2;
      for (const p of hist[k].plays ?? []) {
        if ((p.seat % 2) === (lead.seat % 2)) continue;
        if ((p.seat % 2) === winnerTeam) continue;
        if ((p.cards ?? []).some(x => ps(x) === suit && cardPoints(x) > 0)) dumped = true;
      }
    }

    const cue = outstanding <= 10 && dumped;
    if (cue) onCue += 1;
    // 这一碰把对手的件撞出来了吗
    const out = (t.plays ?? []).slice(1).some(p =>
      (p.seat % 2) !== (lead.seat % 2) && (p.cards ?? []).some(isPiece));
    if (out) bumped += 1;
    if (cue && out) onCueBumped += 1;
  });
}
const pct = (a, b) => b ? `${(a * 100 / b).toFixed(1)}%` : '--';
console.log(`${N} 局：领出副牌件共 ${leadPiece} 次`);
console.log(`  踩在「碰件」两个前提上的（外面 ≤10 张 + 对手赔过分）  ${onCue}\t${pct(onCue, leadPiece)}`);
console.log(`  把对手的件撞出来了                                    ${bumped}\t${pct(bumped, leadPiece)}`);
console.log(`    其中踩在前提上的那些                                ${onCueBumped}\t${pct(onCueBumped, onCue)}`);
console.log(`    没踩在前提上的那些                                  ${bumped - onCueBumped}\t${pct(bumped - onCueBumped, leadPiece - onCue)}`);
