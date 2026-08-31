// Glen 2026-08-30：「BOT 有大小鬼，对手只有小鬼，但没在最后两轮打，
//   倒数三轮二轮就把大小鬼打出来了，导致给对手撬底。」
//
// 口径：每一局，找出【手上同时有大鬼和小鬼】的那一家，看他把这两张鬼
// 打在倒数第几轮，以及本局最后是不是被撬底。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf } from '../../server/cards.js';

const N = Number(process.env.N ?? 200);
const BASE = Number(process.env.BASE ?? 4200);
const bucket = new Map();
const how = new Map();
let both = 0, grabbed = 0, early = 0, earlyGrabbed = 0;

for (let i = 0; i < N; i++) {
  const { state, summary } = await simulateRound({ seed: BASE + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (hist.length < 4) continue;
  const total = hist.length;
  const { trumpSuit, rankCard } = round;

  // 每一家打出大鬼(16)/小鬼(15)的轮次
  const jokers = new Map();   // seat -> [{rank, fromEnd}]
  hist.forEach((t, ti) => {
    for (const p of t.plays ?? [])
      for (const c of p.cards ?? [])
        if (c.rank === 15 || c.rank === 16) {
          if (!jokers.has(p.seat)) jokers.set(p.seat, []);
          const isLead = (t.plays ?? [])[0]?.seat === p.seat;
          // ⚠️ 「被逼的」要看【当时手上有没有更便宜的主可打】，不是「打的是不是主牌」。
          // 手上还有小主却掏了鬼，那是自己选的，不叫被逼。
          // 当时手上有什么 = 他从这一墩起往后打出的所有牌（牌只会变少，还原是准的）。
          let cheaperTrump = false;
          for (let k = ti; k < hist.length; k++)
            for (const q of hist[k].plays ?? [])
              if (q.seat === p.seat)
                for (const x of q.cards ?? [])
                  if (playSuitOf(x, trumpSuit, rankCard) === 'TRUMP' &&
                      x.rank !== 15 && x.rank !== 16) cheaperTrump = true;
          const forced = !isLead && !cheaperTrump;
          jokers.get(p.seat).push({ rank: c.rank, fromEnd: total - ti, isLead, forced });
        }
  });

  for (const [seat, list] of jokers) {
    const hasBig = list.some(j => j.rank === 16);
    const hasSmall = list.some(j => j.rank === 15);
    if (!hasBig || !hasSmall) continue;      // 只看「大小鬼都在他手上」的那一家
    both += 1;
    // 这两张鬼里【最早】那一张打在倒数第几轮
    const earliest = Math.max(...list.map(j => j.fromEnd));
    bucket.set(earliest, (bucket.get(earliest) ?? 0) + 1);
    const isDefender = (seat % 2) !== (round.declarerSeat % 2);
    const grab = !!summary?.kittyGrab;
    // 「被撬底」= 我是庄家一方而底被撬了
    const bad = !isDefender && grab;
    if (bad) grabbed += 1;
    if (earliest >= 3) {
      early += 1;
      if (bad) earlyGrabbed += 1;
      const first = list.find(j => j.fromEnd === earliest);
      const k = first.isLead ? '自己领出去的'
        : first.forced ? '手上只剩鬼了（真的被逼）'
        : '手上还有小主，却掏了鬼';
      how.set(k, (how.get(k) ?? 0) + 1);
    }
  }
}
const pct = (a, b) => b ? `${(a * 100 / b).toFixed(1)}%` : '--';
console.log(`${N} 局：某一家【大小鬼都在手上】的局面共 ${both} 次`);
console.log('  这两张鬼里最早那一张，打在倒数第几轮：');
for (const [k, v] of [...bucket.entries()].sort((a, b) => a[0] - b[0]))
  console.log(`    倒数第 ${String(k).padStart(2)} 轮\t${v}\t${pct(v, both)}`);
console.log(`\n  其中【倒数第 3 轮或更早】就动了鬼的  ${early}\t${pct(early, both)}`);
console.log(`  他是庄家一方而底被撬了：`);
console.log(`    全部          ${grabbed}\t${pct(grabbed, both)}`);
console.log(`    早动鬼的那些  ${earlyGrabbed}\t${pct(earlyGrabbed, early)}`);
console.log('\n  早动的那一张鬼是怎么出去的：');
for (const [k, v] of [...how.entries()].sort((a, b) => b[1] - a[1]))
  console.log(`    ${String(v).padStart(4)}  ${k}\t${pct(v, early)}`);
