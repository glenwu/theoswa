// 「无缘无故领大鬼」——按局配对量：中前段（不含收官 4 墩）有几次把鬼领了出去。
// 收官阶段手上只剩主牌时领鬼是没得选，不算。
import { simulateRound } from '../../server/simulate-bots.js';
const N = Number(process.env.N ?? 400);
for (let i = 0; i < N; i++) {
  const seed = 4200 + i * 977;
  const { state, summary } = await simulateRound({ seed, difficulty: 'expert' });
  const hist = (state?.round?.trickHistory ?? []).filter(t => !t.virtual);
  let early = 0, late = 0;
  hist.forEach((t, k) => {
    const cards = t.plays?.[0]?.cards ?? [];
    if (!cards.some(c => c.rank === 15 || c.rank === 16)) return;
    (hist.length - k <= 4 ? () => { late += 1; } : () => { early += 1; })();
  });
  console.log(JSON.stringify({ seed, grab: !!summary?.kittyGrab, early, late }));
}
