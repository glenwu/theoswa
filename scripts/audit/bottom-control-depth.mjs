// 新的保底判据是「张数对比」，比原来的「独占顶档」宽。这个脚本检查它是不是
// 宽得离谱：统计判定成立时，托底的那张牌落在哪一档。
// 落在鬼/级牌那几档是我们要的；大量落在主花色低档说明是「靠主牌多」硬凑出来的。
import { buildDeck, cardStrength, playSuitOf } from '../../server/cards.js';
import { mulberry32 } from '../../server/rng.js';

const tierName = (strength, ctx) =>
  strength === 1000 ? '大鬼' : strength === 999 ? '小鬼' : strength === 998 ? '主级牌'
  : strength === 997 ? '副级牌' : strength >= 900 ? `主${strength - 900}` : '副牌';

function assess(myTrumps, played, ctx) {
  const tiers = new Map();
  for (const card of buildDeck()) {
    if (playSuitOf(card, ctx.trumpSuit, ctx.rankCard) !== 'TRUMP') continue;
    const key = cardStrength(card, ctx);
    const t = tiers.get(key) ?? { total: 0, mine: 0, played: 0 };
    t.total += 1; tiers.set(key, t);
  }
  for (const c of myTrumps) tiers.get(cardStrength(c, ctx)).mine += 1;
  for (const c of played) { const t = tiers.get(cardStrength(c, ctx)); if (t) t.played += 1; }
  let mine = 0, threats = 0;
  for (const [key, t] of [...tiers.entries()].sort((a, b) => b[0] - a[0])) {
    mine += t.mine; threats += t.total - t.played - t.mine;
    if (t.mine > 0 && threats < mine) return key;
  }
  return null;
}

const ctx = { trumpSuit: 'H', rankCard: 2 };
const trumpDeck = buildDeck().filter(c => playSuitOf(c, 'H', 2) === 'TRUMP');
const rng = mulberry32(20260822);
const hit = new Map(); let total = 0, ok = 0;
for (let i = 0; i < 20000; i++) {
  const pool = [...trumpDeck].sort(() => rng() - 0.5);
  const mineN = 6 + Math.floor(rng() * 8);          // 手上 6~13 张主
  const playedN = Math.floor(rng() * 18);            // 场上已出 0~17 张主
  const myTrumps = pool.slice(0, mineN);
  const played = pool.slice(mineN, mineN + playedN);
  total += 1;
  const key = assess(myTrumps, played, ctx);
  if (key === null) continue;
  ok += 1;
  const name = tierName(key, ctx);
  hit.set(name, (hit.get(name) ?? 0) + 1);
}
console.log(`随机 ${total} 手：保底成立 ${ok} 次（${(ok / total * 100).toFixed(1)}%）`);
console.log('托底那张落在哪一档：');
for (const [k, v] of [...hit.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(6)} ${String(v).padStart(5)}  ${(v / ok * 100).toFixed(1)}%`);
}
