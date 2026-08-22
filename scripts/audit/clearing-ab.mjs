// 「清顶」：对手主牌见底、顶端只剩一两张时，反过来用大牌把顶端一次清完（Glen）。
// 这个脚本量它到底触没触发、什么时候触发 —— 上一版把「不许领鬼」写成硬规则，
// 结果模拟里量不出任何差别，这次要先确认新分支真的被走到了。
import { simulateRound } from '../../server/simulate-bots.js';

const N = Number(process.env.N ?? 60);
const buckets = { 前段: 0, 中段: 0, 尾三墩: 0 };
let bigLeads = 0, rounds = 0, tricks = 0;

for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: 4200 + i * 977, difficulty: 'expert' });
  const round = state?.round;
  if (!round) continue;
  const hist = (round.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  rounds += 1; tricks += hist.length;
  hist.forEach((t, k) => {
    if (t.leadSuit !== 'TRUMP') return;
    const cards = t.plays?.[0]?.cards ?? [];
    const big = cards.some(c =>
      c.rank === 15 || c.rank === 16 ||
      (c.rank === round.rankCard && c.suit === round.trumpSuit));
    if (!big) return;
    bigLeads += 1;
    const left = hist.length - k;
    buckets[left <= 3 ? '尾三墩' : k < hist.length / 2 ? '前段' : '中段'] += 1;
  });
}

console.log(`${rounds} 局 / 共 ${tricks} 墩：领【鬼或主级牌】吊主 ${bigLeads} 次`);
console.log(`  前段 ${buckets.前段} · 中段 ${buckets.中段} · 尾三墩 ${buckets.尾三墩}`);
console.log('  （尾三墩基本是手上只剩主牌、没得选；前/中段才是策略选出来的）');
