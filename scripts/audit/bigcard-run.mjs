// bigcard-decisions.mjs 的被调方：跑 N 局，让插过桩的 bot-policy 把决策打到 stderr。
// 单独跑没有意义，入口在 bigcard-decisions.mjs。
import { simulateRound } from '../../server/simulate-bots.js';
for (let i = 0; i < Number(process.env.N ?? 300); i++) {
  await simulateRound({ seed: 4200 + i * 977, difficulty: 'expert' });
}
