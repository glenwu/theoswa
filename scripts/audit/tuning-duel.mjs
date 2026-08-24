// 两套权重对拍：同一批种子，两队互换阵营各打一遍（消掉庄闲和牌运的偏差）。
// 用来独立复核训练器给出的「候选更强」结论 —— 它自己的留出集只有 60 组。
//   node scripts/audit/tuning-duel.mjs --a=<权重A.json> --b=<权重B.json> [--seeds=200]
import fs from 'node:fs';
import { simulateRound } from '../../server/simulate-bots.js';
import { normalizeBotTuning } from '../../server/bot-policy.js';

const arg = (name, fallback) =>
  process.argv.find(v => v.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const load = p => normalizeBotTuning(JSON.parse(fs.readFileSync(p, 'utf8')).tuning ?? {});

const A = load(arg('a'));
const B = load(arg('b'));
const N = Number(arg('seeds', '200'));
const base = Number(arg('base', '77000000'));

let aWins = 0, bWins = 0, games = 0, aPoints = 0, bPoints = 0;
for (let i = 0; i < N; i += 1) {
  const seed = base + i * 7919;
  const fixedDeclarerSeat = i % 4;
  for (const aTeam of [0, 1]) {
    const { summary, errors } = await simulateRound({
      seed, difficulty: 'expert', fixedDeclarerSeat, declarationMode: 'patient',
      tuningByTeam: aTeam === 0 ? [A, B] : [B, A],
    });
    if (errors.length > 0 || !summary) continue;
    games += 1;
    const declarerTeam = summary.declarerSeat % 2;
    // 庄家方赢 = 没被移庄；闲家方赢 = 移庄成功
    const winnerTeam = summary.transfer ? 1 - declarerTeam : declarerTeam;
    if (winnerTeam === aTeam) aWins += 1; else bWins += 1;
    // 闲家台面分归闲家那一队，用来看「谁更能吃分」
    const defTeam = 1 - declarerTeam;
    if (defTeam === aTeam) aPoints += summary.defenderPoints; else bPoints += summary.defenderPoints;
  }
}
const pct = n => `${(n / Math.max(1, games) * 100).toFixed(1)}%`;
console.log(`对拍 ${games} 局（${N} 种子 × 换边）`);
console.log(`  A 胜 ${aWins}（${pct(aWins)}）   B 胜 ${bWins}（${pct(bWins)}）`);
console.log(`  做闲家时平均台面分：A ${(aPoints / Math.max(1, games / 2)).toFixed(1)}  B ${(bPoints / Math.max(1, games / 2)).toFixed(1)}`);
