// 副A 和 副K 谁先被打出去？A 是这门的老大（牵制），K 是 10 分的负债 ——
// 正常打法应该是 K 先走、A 留着。keepValue 一律给 45 的时候顺序是反的。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf } from '../../server/cards.js';
const N = Number(process.env.N ?? 300);
let aFirst = 0, kFirst = 0, both = 0, aEarly = 0, kEarly = 0;
for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: 4200 + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  const { trumpSuit, rankCard } = round;
  // 每个座位、每门副牌：它的 A 和 K 分别在第几墩出的
  const when = new Map();
  hist.forEach((t, k) => {
    for (const play of t.plays ?? []) {
      for (const c of play.cards ?? []) {
        if (playSuitOf(c, trumpSuit, rankCard) === 'TRUMP') continue;
        if (c.rank !== 14 && c.rank !== 13) continue;
        if (c.rank === rankCard) continue;
        const key = `${play.seat}-${c.suit}-${c.rank}`;
        if (!when.has(key)) when.set(key, k);
        if (k < hist.length / 2) (c.rank === 14 ? () => { aEarly += 1; } : () => { kEarly += 1; })();
      }
    }
  });
  for (const [key, at] of when) {
    if (!key.endsWith('-14')) continue;
    const kk = key.replace('-14', '-13');
    if (!when.has(kk)) continue;
    both += 1;
    if (at < when.get(kk)) aFirst += 1; else if (at > when.get(kk)) kFirst += 1;
  }
}
console.log(`${N} 局；同一家同一门里 A 和 K 都出过的共 ${both} 组`);
console.log(`  A 先走 ${aFirst} 次 (${(aFirst / Math.max(1, both) * 100).toFixed(0)}%)   K 先走 ${kFirst} 次 (${(kFirst / Math.max(1, both) * 100).toFixed(0)}%)`);
console.log(`  前半场打出：副A ${aEarly} 张 / 副K ${kEarly} 张`);
