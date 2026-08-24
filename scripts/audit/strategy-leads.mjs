// 策略接到领牌上之后，各策略下的领牌构成变了没有？
// 「以跑副牌为主」的局面该多领副牌，「吃分为主」的该多打对手的长门。
import { simulateRound } from '../../server/simulate-bots.js';
const N = Number(process.env.N ?? 200);
let trumpLead = 0, sideLead = 0, tricks = 0;
const byPhase = { 前半: { trump: 0, side: 0 }, 后半: { trump: 0, side: 0 } };
for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: 4200 + i * 977, difficulty: 'expert' });
  const hist = (state?.round?.trickHistory ?? []).filter(t => !t.virtual);
  hist.forEach((t, k) => {
    tricks += 1;
    const bucket = k < hist.length / 2 ? byPhase.前半 : byPhase.后半;
    if (t.leadSuit === 'TRUMP') { trumpLead += 1; bucket.trump += 1; }
    else { sideLead += 1; bucket.side += 1; }
  });
}
const pct = (a, b) => `${(a / Math.max(1, a + b) * 100).toFixed(1)}%`;
console.log(`${N} 局 / ${tricks} 墩：领主 ${trumpLead}（${pct(trumpLead, sideLead)}）领副 ${sideLead}`);
console.log(`  前半场 领主 ${byPhase.前半.trump} / 领副 ${byPhase.前半.side}  → 领主占 ${pct(byPhase.前半.trump, byPhase.前半.side)}`);
console.log(`  后半场 领主 ${byPhase.后半.trump} / 领副 ${byPhase.后半.side}  → 领主占 ${pct(byPhase.后半.trump, byPhase.后半.side)}`);
