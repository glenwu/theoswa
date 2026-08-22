// 鬼（15/16）什么时候被打出来，以及有没有出现「队友已经领先，还拿鬼盖上去」。
import { simulateRound } from '../../server/simulate-bots.js';
import { trickLeader } from '../../server/trick.js';
import { cardPoints } from '../../server/cards.js';

const N = Number(process.argv[2] ?? 10);
let jokers = 0, sumTrick = 0, early = 0, ledJoker = 0, wasted = 0, tricks = 0, rounds = 0;
for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: 7777 + i * 613, difficulty: 'expert' });
  const h = (state?.round?.trickHistory ?? []).filter(t => !t.virtual);
  if (h.length === 0) continue;
  rounds++; tricks += h.length;
  const ctx = { trumpSuit: state.round.trumpSuit, rankCard: state.round.rankCard };
  h.forEach((t, idx) => {
    const plays = t.plays ?? [];
    plays.forEach((p, pi) => {
      const hasJoker = (p.cards ?? []).some(c => c.rank === 15 || c.rank === 16);
      if (!hasJoker) return;
      jokers++; sumTrick += idx + 1;
      if (idx < 3) early++;
      if (pi === 0) { ledJoker++; return; }
      // 出这张之前，牌面最大的是不是我队友？桌上有没有分？
      const before = trickLeader(plays.slice(0, pi), ctx);
      const after = trickLeader(plays.slice(0, pi + 1), ctx);
      const partnerWasLeading = before && before.seat === (p.seat + 2) % 4;
      const iTookOver = after && after.seat === p.seat;
      const pts = plays.slice(0, pi + 1)
        .flatMap(x => x.cards ?? []).reduce((n, c) => n + cardPoints(c), 0);
      if (partnerWasLeading && iTookOver && pts === 0) wasted++;
    });
  });
}
console.log(`  ${rounds} 局 / ${tricks} 轮，共打出 ${jokers} 张鬼`);
console.log(`    平均在第 ${(sumTrick / Math.max(1, jokers)).toFixed(1)} 轮出现（越大越好）`);
console.log(`    前三轮就打掉：${early} 张 (${(early / Math.max(1, jokers) * 100).toFixed(0)}%)`);
console.log(`    直接领出鬼：  ${ledJoker} 张`);
console.log(`    ⚠️ 队友已领先、桌上无分，还拿鬼盖过去：${wasted} 张`);
