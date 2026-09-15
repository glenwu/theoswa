// Glen 2026-09-15：「现在碰到很多次是件已经出了，但队友却还一直捅短这一门牌，
//   让这一门变得很短不好甩或威胁降低。」
//
// 他给的读法：
//   · 队友看到你求件，默认你手上是【两件】；第一次领这门就领【件】→ 至少三件
//     （Glen 2026-09-16：「这个花色第一轮打件出来，至少是三件」）
//   · 外边已经出了两件（包括队友自己出的）→ 假设你已经可以甩了，
//     不再为你打这门，可以转去吊主
//   · 这之后你【又打这门】→ 说明你是一求三，继续帮你打
//
// 口径：某门的第一次领牌是 A（求件者）的求件牌；之后 A 的队友 L 拿到牌权
// 又领这门 ——「帮他打」。按上面的读法，这一领时 A 是不是【已经甩得动了】。
// 「外边出了」= 这门的件里，不是 A 打出来的那些（含埋底亮出的）。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf } from '../../server/cards.js';

const N = Number(process.env.N ?? 200);
let helpLeads = 0, overPush = 0, overPushHolding = 0;
let askerThrewAfter = 0, askerThrewAfterOver = 0, overRounds = 0;
const reason = new Map();
const whyMap = new Map();

for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: 4200 + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  const { trumpSuit, rankCard } = round;
  const ps = c => playSuitOf(c, trumpSuit, rankCard);
  const isPiece = c => ps(c) !== 'TRUMP' && (c.rank === 14 || c.rank === 13) && c.rank !== rankCard;
  const isAsk = cards => cards.length === 1 &&
    (isPiece(cards[0]) || cards[0].rank <= 5 || cards[0].rank === 10);
  const kittyPieces = suit => (round.kitty ?? []).filter(c => ps(c) === suit && isPiece(c)).length;
  const totalPieces = suit => [14, 13].filter(r => r !== rankCard).length * 2;
  const start = new Map(state.players.map(p => [p.seat, [
    ...p.hand, ...hist.flatMap(t => (t.plays ?? []).filter(x => x.seat === p.seat).flatMap(x => x.cards))]]));
  const handAt = (seat, ti) => {
    const gone = new Set();
    for (let k = 0; k < ti; k++) for (const p of hist[k].plays ?? []) if (p.seat === seat)
      for (const c of p.cards ?? []) gone.add(c.id);
    return (start.get(seat) ?? []).filter(c => !gone.has(c.id));
  };
  // 第 ti 墩开打前，这门「外边出了」几件（不是 asker 打的 + 埋底亮出的）
  const outsideOut = (suit, asker, ti) => {
    let n = kittyPieces(suit);
    for (let k = 0; k < ti; k++) for (const p of hist[k].plays ?? [])
      if (p.seat !== asker) n += (p.cards ?? []).filter(c => ps(c) === suit && isPiece(c)).length;
    return n;
  };

  const firstLead = new Map();                        // suit -> {seat, ti, ask}
  let roundHadOver = false;
  hist.forEach((t, ti) => {
    const lead = t.plays?.[0];
    if (!lead || t.leadSuit === 'TRUMP') return;
    const suit = t.leadSuit;
    if (!firstLead.has(suit)) {
      firstLead.set(suit, { seat: lead.seat, ti, ask: isAsk(lead.cards ?? []),
        piece: (lead.cards ?? []).some(isPiece) });
      return;
    }
    const f = firstLead.get(suit);
    if (!f.ask) return;
    const asker = f.seat;
    const helper = (asker + 2) % 4;
    if (lead.seat !== helper) return;                  // 只看队友「帮他打」的那些领牌
    helpLeads += 1;
    const T = totalPieces(suit);
    // 推 A 手上几件：小牌/10 求件默认两件、领件求件默认三件；
    // A 在「外边已出够 T-H 件」之后又领这门 → 少算一件（一路减到一求三）
    let H = Math.min(f.piece ? 3 : 2, T - 1);
    for (let k = f.ti + 1; k < ti; k++) {
      const l2 = hist[k].plays?.[0];
      if (l2?.seat === asker && hist[k].leadSuit === suit && H > 1 && outsideOut(suit, asker, k) >= T - H) H -= 1;
    }
    const out = outsideOut(suit, asker, ti);
    if (out < T - H) return;                           // 还没出够，该帮
    overPush += 1;
    roundHadOver = true;
    const holding = handAt(helper, ti).some(c => ps(c) === suit && isPiece(c));
    // 拆原因：他最近一次领牌是不是换了门 / 我领的是不是件（续打贡献件）/ 是不是甩牌
    let lastAskerLead = null;
    for (let k = ti - 1; k >= 0; k--) if (hist[k].plays?.[0]?.seat === asker) { lastAskerLead = hist[k]; break; }
    const why = holding ? '我手上还压着件'
      : (lead.cards ?? []).length > 1 ? '我是在甩这门'
      : (lead.cards ?? []).some(isPiece) ? '我领的是件'
      : lastAskerLead && lastAskerLead.leadSuit !== suit ? `他最近一领换成了${lastAskerLead.leadSuit === 'TRUMP' ? '主' : '别的副门'}`
      : '其它';
    whyMap.set(why, (whyMap.get(why) ?? 0) + 1);
    if (holding) overPushHolding += 1;
    reason.set(`H=${H} 外边已出 ${out}/${T}${holding ? ' · 我手上还压着件' : ''}`,
      (reason.get(`H=${H} 外边已出 ${out}/${T}${holding ? ' · 我手上还压着件' : ''}`) ?? 0) + 1);
    // A 后来有没有甩这门
    const threw = hist.slice(ti + 1).some(t2 => t2.plays?.[0]?.seat === asker &&
      (t2.plays[0].cards ?? []).length > 1 && ps(t2.plays[0].cards[0]) === suit);
    if (threw) askerThrewAfterOver += 1;
  });
  if (roundHadOver) overRounds += 1;
}
const pct = (a, b) => b ? `${(a * 100 / b).toFixed(1)}%` : '--';
console.log(`${N} 局：队友在求件者那门【帮他打】的领牌 ${helpLeads} 次`);
console.log(`  其中按 Glen 的读法求件者【已经甩得动了】还在捅  ${overPush}\t${pct(overPush, helpLeads)}（涉及 ${overRounds} 局）`);
console.log(`    其中我手上还压着这门的件            ${overPushHolding}`);
console.log(`    被捅过之后求件者还是甩了这门        ${askerThrewAfterOver}\t${pct(askerThrewAfterOver, overPush)}`);
console.log('  分布：');
for (const [k, v] of [...reason.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(4)}  ${k}`);
console.log('  还在捅的原因：');
for (const [k, v] of [...whyMap.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(4)}  ${k}`);
