// Glen 2026-08-30 描述的「甩尾手」：
//   「利用自己可以甩的一门副牌，数量看场上的主数量而定，最终用这手牌在最后一手甩掉。
//     如果对手没足够的主，即是全主，还有其它副牌，那么即使有多少个鬼都会被反杀，
//     是釜底抽薪的一招。条件：1 自己有一门可以甩的副牌，长度越长越好；
//     2 场面上一般得有比较长的吊主行为，此消彼长；3 需要有起手牌 ——
//     甩牌的前一轮需要保证大，通常大鬼最好，其次可以毙别人，
//     也可以是副牌的 A（前提是这门牌没怎么打）。」
//
// 口径：把每一局里【真正甩出去的多张副牌】找出来，按「是不是尾盘甩」「甩了几张」
// 「对手当时还剩多少主（估）」分类，再看这一甩有没有被毙。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf, cardPoints } from '../../server/cards.js';

const N = Number(process.env.N ?? 200);
const BASE = Number(process.env.BASE ?? 4200);

let rounds = 0, throwTricks = 0, tailThrows = 0, killed = 0, pts = 0;
let killedPts = 0, safePts = 0, lost = 0;
const byLen = new Map();
const stage = new Map();

for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: BASE + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  rounds += 1;
  const { trumpSuit, rankCard } = round;
  const ps = c => playSuitOf(c, trumpSuit, rankCard);

  hist.forEach((t, ti) => {
    const lead = t.plays?.[0];
    const cards = lead?.cards ?? [];
    if (cards.length < 2 || t.leadSuit === 'TRUMP') return;   // 只看副牌甩牌
    throwTricks += 1;
    byLen.set(cards.length, (byLen.get(cards.length) ?? 0) + 1);
    // 尾盘 = 这一甩之后本局只剩 ≤2 墩
    const left = hist.length - ti - 1;
    const k = left <= 1 ? '最后一两轮' : left <= 3 ? '倒数第 3~4 轮' : '中前盘';
    stage.set(k, (stage.get(k) ?? 0) + 1);
    if (left <= 1) tailThrows += 1;
    // 被毙了吗
    // ⚠️ 「被毙」只算【对手】毙走。队友毙我的甩牌，分还在我方，那不算亏 ——
    // 第一版没分队友和对手，把队友毙也记成白送，账整个是错的。
    const winner = (t.plays ?? []).find(p => p.seat === t.winnerSeat);
    const cut = !!winner && (winner.seat % 2) !== (lead.seat % 2) &&
      (winner.cards ?? []).some(c => ps(c) === 'TRUMP');
    const lostToOpponent = !!winner && (winner.seat % 2) !== (lead.seat % 2);
    const p = (t.plays ?? []).flatMap(x => x.cards ?? []).reduce((s, c) => s + cardPoints(c), 0);
    pts += p;
    if (cut) killed += 1;
    if (lostToOpponent) killedPts += p; else safePts += p;
    if (lostToOpponent) lost += 1;
  });
}

const pct = (a, b) => b ? `${(a * 100 / b).toFixed(1)}%` : '--';
console.log(`${rounds} 局：副牌甩牌共 ${throwTricks} 次（平均每局 ${(throwTricks / rounds).toFixed(2)} 次）`);
console.log(`  其中甩在【最后一两轮】（真正的甩尾手）  ${tailThrows}\t${pct(tailThrows, throwTricks)}`);
console.log(`  被【对手】毙掉                          ${killed}\t${pct(killed, throwTricks)}`);
console.log(`  这一墩最后被对手拿走（含毙和大牌）      ${lost}\t${pct(lost, throwTricks)}`);
console.log(`  这些甩牌墩平均 ${(pts / Math.max(1, throwTricks)).toFixed(1)} 分`);
console.log(`    被对手拿走的那些平均 ${(killedPts / Math.max(1, lost)).toFixed(1)} 分`);
console.log(`    我方拿下的平均       ${(safePts / Math.max(1, throwTricks - lost)).toFixed(1)} 分`);
console.log(`    净账：送给对手 ${killedPts} 分，我方拿到 ${safePts} 分`);
console.log('\n按甩出的张数：');
for (const [n, c] of [...byLen.entries()].sort((a, b) => a[0] - b[0]))
  console.log(`  ${n} 张\t${c}`);
console.log('\n按时机：');
for (const [k, c] of [...stage.entries()].sort((a, b) => b[1] - a[1]))
  console.log(`  ${k}\t${c}\t${pct(c, throwTricks)}`);
