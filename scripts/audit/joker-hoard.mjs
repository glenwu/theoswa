// Glen 再次强调的那条：「留鬼保底/撬底是基本打法，不能见牌或见分就砍。
//   有保底/撬底的鬼组合（如大小鬼）还是见牌就砍，需要再严格地出这个规则。」
//
// 口径和 loose-piece.mjs 一致 —— 只认【躲得掉却还是砍了】：把每次出牌还原成
// 当时合法的选择集，问一句「这一手能不能一张鬼都不出」。能，却还是出了 → 记账。
// 再按【当时手上还有几张鬼】和【这一墩值多少分】分栏：
//   手上有两张以上 = Glen 说的「鬼组合」，那是保底/撬底的本钱，最不该动。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf, cardPoints } from '../../server/cards.js';

const N_ROUNDS = Number(process.env.N ?? 200);
const BASE = Number(process.env.BASE ?? 4200);

let played = 0, forced = 0, avoidable = 0;
const bucket = new Map();
const add = k => bucket.set(k, (bucket.get(k) ?? 0) + 1);
const bandOf = p => p >= 30 ? '≥30 分' : p >= 20 ? '20~25 分' : p >= 10 ? '10~15 分' : p > 0 ? '5 分' : '一分没有';

for (let i = 0; i < N_ROUNDS; i++) {
  const { state } = await simulateRound({ seed: BASE + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  const { trumpSuit, rankCard } = round;
  const ps = c => playSuitOf(c, trumpSuit, rankCard);
  const isJoker = c => c.rank === 15 || c.rank === 16;

  const handOf = (seat, ti) => {
    const out = [];
    for (let k = ti; k < hist.length; k++)
      for (const p of hist[k].plays ?? [])
        if (p.seat === seat) out.push(...(p.cards ?? []));
    return out;
  };

  hist.forEach((t, ti) => {
    const lead = t.plays?.[0];
    if (!lead) return;
    const n = lead.cards?.length ?? 1;
    const pts = (t.plays ?? []).flatMap(p => p.cards ?? []).reduce((s, c) => s + cardPoints(c), 0);
    for (const play of t.plays ?? []) {
      const mine = play.cards ?? [];
      const jokers = mine.filter(isJoker);
      if (!jokers.length) continue;
      played += jokers.length;
      const hand = handOf(play.seat, ti);
      const held = hand.filter(isJoker).length;

      let canDodge;
      if (play.seat === t.leadSeat) {
        canDodge = hand.length > jokers.length;      // 领牌：手上还有别的牌就是自己选的
      } else {
        const inSuit = hand.filter(c => ps(c) === t.leadSuit);
        if (inSuit.length >= n) canDodge = inSuit.filter(c => !isJoker(c)).length >= n;
        else {
          const stuck = inSuit.filter(isJoker).length;
          const filler = hand.filter(c => ps(c) !== t.leadSuit);
          canDodge = stuck === 0 && filler.filter(c => !isJoker(c)).length >= n - inSuit.length;
        }
      }
      if (!canDodge) { forced += jokers.length; continue; }
      avoidable += jokers.length;
      const won = t.winnerSeat === play.seat;
      add(`${held >= 2 ? '鬼组合（≥2 张）' : '就这一张鬼    '} · ${bandOf(pts)} · ${hand.length > 8 ? '早中盘(>8张)' : '后半盘(≤8张)'}`);
    }
  });
}

const pct = n => `${(n * 100 / played).toFixed(1)}%`;
console.log(`${N_ROUNDS} 局：一共打出鬼 ${played} 张`);
console.log(`  躲不掉（手上只剩鬼 / 该门必须全出）  ${forced}\t${pct(forced)}`);
console.log(`  躲得掉却还是砍了                      ${avoidable}\t${pct(avoidable)}`);
console.log('\n躲得掉的那些：');
[...bucket.entries()].sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log(`  ${String(v).padStart(5)}  ${(v * 100 / avoidable).toFixed(1).padStart(5)}%  ${k}`));
