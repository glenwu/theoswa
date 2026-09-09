// Glen 2026-09-09 第二条：
//   「吊主的时候，经常第四家 BOT 如果第三家是出的 A，必定出 2，或是第三家副 2，
//     必定主 2，实际上这时候也要分情况，如果没有分，而且自己也无所谓别人吊主
//    （即自己不是保底/撬底牌或是没有要求件的副门）就可以放一下，
//     因为 2 和主 2 还是相对比较大的牌，不需要浪费在无分的局。」
//
// 口径：主牌墩、我是第四家、这一墩【一分没有】，而我用【级牌】（副级牌或主级牌）
// 去把它拿下来 —— 也就是他说的「浪费在无分的局」。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf, cardPoints } from '../../server/cards.js';

const N = Number(process.env.N ?? 200);
let fourthTrump = 0, zeroPoint = 0, spentRank = 0, spentMain = 0, wonAnyway = 0;
let hadCheaper = 0, hadCheaperMain = 0;
let ptTricks = 0, ptCovered = 0;

for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: 4200 + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  const { trumpSuit, rankCard } = round;
  const ps = c => playSuitOf(c, trumpSuit, rankCard);
  const isRank = c => c.rank === rankCard && ps(c) === 'TRUMP';
  const isMainRank = c => c.rank === rankCard && c.suit === trumpSuit;

  const handAt = (seat, ti) => {
    const out = [];
    for (let k = ti; k < hist.length; k++)
      for (const p of hist[k].plays ?? [])
        if (p.seat === seat) out.push(...(p.cards ?? []));
    return out;
  };
  hist.forEach((t, ti) => {
    const plays = t.plays ?? [];
    if (plays.length !== 4 || t.leadSuit !== 'TRUMP') return;
    if ((plays[0].cards ?? []).length !== 1) return;              // 只看单张的吊主
    const fourth = plays[3];
    fourthTrump += 1;
    const pts = plays.flatMap(p => p.cards ?? []).reduce((s, c) => s + cardPoints(c), 0);
    if (pts !== 0) {
      // 对照组：【有分】的主牌墩，末家有没有用级牌把它盖下来
      ptTricks += 1;
      const m2 = fourth.cards?.[0];
      if (m2 && isRank(m2) && t.winnerSeat === fourth.seat) ptCovered += 1;
      return;
    }
    zeroPoint += 1;
    const mine = fourth.cards?.[0];
    if (!mine || !isRank(mine)) return;
    spentRank += 1;
    if (isMainRank(mine)) spentMain += 1;
    if (t.winnerSeat === fourth.seat) wonAnyway += 1;
    // 当时手上有没有【更便宜的主】可以跟（跟主牌墩必须出主，问题只在出哪一张）
    const cheaper = handAt(fourth.seat, ti).filter(
      c => ps(c) === 'TRUMP' && c.rank !== 15 && c.rank !== 16 && c.rank !== rankCard
    );
    if (cheaper.length > 0) {
      hadCheaper += 1;
      if (isMainRank(mine)) hadCheaperMain += 1;
    }
  });
}
const pct = (a, b) => b ? `${(a * 100 / b).toFixed(1)}%` : '--';
console.log(`${N} 局：单张主牌墩 ${fourthTrump} 个，其中【一分没有】的 ${zeroPoint} 个`);
console.log(`  第四家用【级牌】把无分墩拿下  ${spentRank}\t${pct(spentRank, zeroPoint)}`);
console.log(`    其中花的是【主级牌】        ${spentMain}`);
console.log(`    确实赢下来了                ${wonAnyway}`);
console.log(`  对照·【有分】的主牌墩 ${ptTricks} 个，末家用级牌盖下来 ${ptCovered}\t${pct(ptCovered, ptTricks)}`);
console.log(`    ⚠️ 当时手上【有更便宜的主】  ${hadCheaper}\t${pct(hadCheaper, spentRank)}（其中花主级牌 ${hadCheaperMain}）`);
