// 审计脚本（不进主干）：统计碾压收尾在真实 bot 对局中的触发频率。
import { simulateRound } from '../../server/simulate-bots.js';

const games = Number(process.argv[2] ?? 60);
let viaDominance = 0, totalTricks = 0, counted = 0;

for (let i = 0; i < games; i++) {
  const { state } = await simulateRound({ seed: 20260817 + i * 7919, difficulty: 'expert' });
  const history = state?.round?.trickHistory ?? [];
  if (history.length === 0) continue;
  counted++;
  totalTricks += history.length;
  if (history.some(t => t.virtual === true)) viaDominance++;
}
console.log(`模拟 ${counted} 局：经碾压提前结束 ${viaDominance} 局（${(viaDominance / counted * 100).toFixed(0)}%）`);
console.log(`平均轮数 ${(totalTricks / counted).toFixed(1)}（打满 25 轮；碾压局的虚拟轮也计 1 轮）`);
