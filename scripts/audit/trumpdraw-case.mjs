// 主牌到底有没有被吊出来 —— 看「主牌领出的轮数」和「主牌出现的早晚」，
// 而不是「庄家领主几次」（吊小牌会丢牌权，次数天然就低）。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf } from '../../server/cards.js';

const N = Number(process.argv[2] ?? 12);
let trumpLedTricks = 0, tricks = 0, rounds = 0, weightedPos = 0, trumpCards = 0;
for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: 4242 + i * 977, difficulty: 'expert' });
  const h = (state?.round?.trickHistory ?? []).filter(t => !t.virtual);
  if (h.length === 0) continue;
  rounds++; tricks += h.length;
  const ctx = { trumpSuit: state.round.trumpSuit, rankCard: state.round.rankCard };
  h.forEach((t, idx) => {
    if (t.leadSuit === 'TRUMP') trumpLedTricks++;
    for (const p of t.plays ?? []) for (const c of p.cards ?? []) {
      if (playSuitOf(c, ctx.trumpSuit, ctx.rankCard) === 'TRUMP') { trumpCards++; weightedPos += idx; }
    }
  });
}
console.log(`  ${rounds} 局 / ${tricks} 轮：主牌领出的轮数 ${trumpLedTricks}` +
  ` (${(trumpLedTricks / tricks * 100).toFixed(0)}%)`);
console.log(`  主牌平均在第 ${(weightedPos / Math.max(1, trumpCards)).toFixed(1)} 轮出现（越小=吊得越早）`);
