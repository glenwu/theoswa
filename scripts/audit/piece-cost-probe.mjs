// 「对手在求这门，我却把件砍了出去」那一刻，代价到底算出来多少？
// pieceExposureRisk 是三个系数【相乘】：clamp(threat,0.5,2) × read × stake。
// 源码注释按 exposureRisk = 1 推出「等效门槛 25 分」，这里量它的真实取值。
import fs from 'node:fs';
const F = 'server/bot-policy.js';
const src = fs.readFileSync(F, 'utf8');
const restore = () => fs.writeFileSync(F, src);
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('SIGTERM', () => { restore(); process.exit(143); });

const OLD = `    return sum +
      Math.min(PIECE_THREAT_MAX, Math.max(PIECE_THREAT_MIN, threat)) * read * stake;`;
const NEW = `    const __r = Math.min(PIECE_THREAT_MAX, Math.max(PIECE_THREAT_MIN, threat)) * read * stake;
    if (globalThis.__probe) globalThis.__probe.push({
      signal, threat: Math.min(PIECE_THREAT_MAX, Math.max(PIECE_THREAT_MIN, threat)),
      read, stake, risk: __r, cost: __r * PIECE_EXPOSURE_COST,
    });
    return sum + __r;`;
if (!src.includes(OLD)) { console.error('锚点失效'); process.exit(1); }
fs.writeFileSync(F, src.replace(OLD, NEW));

try {
  globalThis.__probe = [];
  const { simulateRound } = await import('../../server/simulate-bots.js');
  const N = Number(process.env.N ?? 100);
  for (let i = 0; i < N; i++) await simulateRound({ seed: 4200 + i * 977, difficulty: 'expert' });
  const rows = globalThis.__probe.filter(r => r.signal === 'opponent');
  const q = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length * p)];
  const costs = rows.map(r => r.cost);
  const stakes = rows.map(r => r.stake);
  const threats = rows.map(r => r.threat);
  console.log(`${N} 局，「对手在求这门」时算过的件代价 ${rows.length} 次`);
  const show = (name, a) => console.log(
    `  ${name}\t中位 ${q(a, .5).toFixed(2)}\t四分位 ${q(a, .25).toFixed(2)} ~ ${q(a, .75).toFixed(2)}\t最大 ${Math.max(...a).toFixed(2)}`);
  show('threat', threats);
  show('stake ', stakes);
  show('代价  ', costs);
  const bonus = p => 100 + p * 10;
  console.log(`\n接管加分 = 100 + 桌上分×10：0分→${bonus(0)}  10分→${bonus(10)}  15分→${bonus(15)}  20分→${bonus(20)}`);
  for (const p of [0, 5, 10, 15, 20, 25]) {
    const beaten = costs.filter(c => c < bonus(p)).length;
    console.log(`  桌上 ${String(p).padStart(2)} 分时，加分压得过代价的场合 ${beaten}/${costs.length}  ${(beaten*100/costs.length).toFixed(0)}%`);
  }
} finally { restore(); }
