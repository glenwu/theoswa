// Glen 2026-09-09 第五次提第三家：
//   「当 BOT 是第三个出牌的时候经常没有打大过 10 的牌，很容易放第四家的 10 吃分，
//     如果有大过 10 的，如 QJ 或是主牌的副 2 及以下最好是尽力拦一下，
//     当然不要乱出大牌（主 2 及以上）和件。」
//
// 「QJ」那一半（跟得上这门时用 J/Q 封）已经在 third-hand.mjs 里量着，实测 92% 做到了。
// 这个脚本量的是【新的那一半】：这门我断了，跟不了，手上有「副 2 及以下」的主牌，
// 该不该毙一手把第四家的 10 拦掉。
//
// 「主牌的副 2 及以下」= 主牌里【除了大鬼、小鬼、主级牌】的全部
//（副级牌在主花色 A 之上，所以「副 2 及以下」就是这三样以外的所有主牌）。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf, cardPoints, cardStrength } from '../../server/cards.js';

const N = Number(process.env.N ?? 200);
let chances = 0, ruffed = 0, dumped = 0;
let stolen = 0, stolenPts = 0;

for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: 4200 + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  const { trumpSuit, rankCard } = round;
  const ctx = { trumpSuit, rankCard };
  const ps = c => playSuitOf(c, trumpSuit, rankCard);
  // 「副 2 及以下」的主牌：不是鬼、也不是主级牌
  const smallTrump = c =>
    ps(c) === 'TRUMP' && c.rank !== 15 && c.rank !== 16 &&
    !(c.rank === rankCard && c.suit === trumpSuit);

  const handOf = (seat, ti) => {
    const out = [];
    for (let k = ti; k < hist.length; k++)
      for (const p of hist[k].plays ?? [])
        if (p.seat === seat) out.push(...(p.cards ?? []));
    return out;
  };

  hist.forEach((t, ti) => {
    const plays = t.plays ?? [];
    if (plays.length !== 4) return;
    const lead = plays[0];
    if (t.leadSuit === 'TRUMP' || (lead.cards?.length ?? 1) !== 1) return;
    const third = plays[2];
    if (!third || (plays[3].seat % 2) === (third.seat % 2)) return;   // 第四家得是对手
    // 前两手都跟了这门、都小于 10 —— 也就是「第四家一张 10 就能拿走」的局面
    const firstTwo = plays.slice(0, 2);
    if (!firstTwo.every(p => (p.cards ?? []).length === 1 && ps(p.cards[0]) === t.leadSuit)) return;
    if (!firstTwo.every(p => p.cards[0].rank < 10)) return;

    // 我这门断了（整局往后再没出过这门）才谈得上毙
    const rest = handOf(third.seat, ti);
    if (rest.some(c => ps(c) === t.leadSuit)) return;
    // 手上有「副 2 及以下」的主
    const usable = rest.filter(smallTrump);
    if (usable.length === 0) return;

    chances += 1;
    const mine = third.cards?.[0];
    if (mine && ps(mine) === 'TRUMP') { ruffed += 1; return; }
    dumped += 1;
    if (t.winnerSeat === plays[3].seat) {
      stolen += 1;
      stolenPts += plays.flatMap(p => p.cards ?? []).reduce((s, c) => s + cardPoints(c), 0);
    }
    if (process.env.SHOW && dumped <= Number(process.env.SHOW)) {
      const lbl = c => `${ps(c)}${c.rank}`;
      console.log(JSON.stringify({
        主: trumpSuit, 打: rankCard, 领: t.leadSuit,
        桌面: plays.slice(0, 2).map(p => lbl(p.cards[0])),
        我垫: lbl(mine),
        手上能毙的主: usable.map(lbl),
        第四家: lbl(plays[3].cards[0]),
        这墩分: plays.flatMap(p => p.cards ?? []).reduce((s, c) => s + cardPoints(c), 0),
        被第四家拿走: t.winnerSeat === plays[3].seat,
      }));
    }
  });
}
const pct = n => chances ? `${(n * 100 / chances).toFixed(1)}%` : '--';
console.log(`${N} 局：第三家「这门断了 + 前两手都不到 10 + 手上有副2及以下的主」共 ${chances} 次`);
console.log(`  毙了                ${ruffed}\t${pct(ruffed)}`);
console.log(`  垫牌没毙            ${dumped}\t${pct(dumped)}`);
console.log(`    其中被第四家拿走  ${stolen}\t共 ${stolenPts} 分`);
