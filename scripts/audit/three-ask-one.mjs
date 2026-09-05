// Glen 2026-09-06：「三求一的时候，就是 AAK 或 AKK 的时候，一般会是第一次打这门牌
//   的时候出个 A，BOT 队友基本没有看到回应过，正常这时候要把件给出去，
//   对家就是可以甩牌的状态了。」
//
// 口径：找出每一次【这门第一次被领 + 领的是单张副牌件】，把领牌人当时手上的件数
// 数出来（≥3 才是真三求一）；再看他队友当时手上有没有件、这一墩交没交出来。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf } from '../../server/cards.js';

const N = Number(process.env.N ?? 200);
const BASE = Number(process.env.BASE ?? 4200);

let askLeads = 0, threeOne = 0, partnerHad = 0, partnerGave = 0;
let anyHad = 0, anyGave = 0;
let fakeLead = 0, fakeHad = 0, fakeGave = 0;
let askerThrew = 0;   // 领牌人手上只有 1 件 = 假求件              // 不限三求一：所有「领件求件」的应答率
let oppHad = 0, oppGave = 0;              // 对照：对手手上有件时交出来的比例

for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: BASE + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  const { trumpSuit, rankCard } = round;
  const ps = c => playSuitOf(c, trumpSuit, rankCard);
  const isPiece = c => ps(c) !== 'TRUMP' && (c.rank === 14 || c.rank === 13) && c.rank !== rankCard;

  // 每家的初始手牌 = 局末剩的 + 本局打过的
  const start = new Map(state.players.map(p => [p.seat, [
    ...p.hand,
    ...hist.flatMap(t => (t.plays ?? []).filter(x => x.seat === p.seat).flatMap(x => x.cards)),
  ]]));
  // 第 ti 墩【开打前】某家手上还有的牌
  const handAt = (seat, ti) => {
    const gone = new Set();
    for (let k = 0; k < ti; k++)
      for (const p of hist[k].plays ?? [])
        if (p.seat === seat) for (const c of p.cards ?? []) gone.add(c.id);
    return (start.get(seat) ?? []).filter(c => !gone.has(c.id));
  };

  const ledSuits = new Set();
  hist.forEach((t, ti) => {
    const lead = t.plays?.[0];
    const cards = lead?.cards ?? [];
    const suit = cards.length ? ps(cards[0]) : null;
    if (!suit || suit === 'TRUMP') return;
    const first = !ledSuits.has(suit);
    ledSuits.add(suit);
    if (!first || cards.length !== 1 || !isPiece(cards[0])) return;

    askLeads += 1;
    const held = handAt(lead.seat, ti).filter(c => ps(c) === suit && isPiece(c)).length;
    const three = held >= 3;
    if (three) threeOne += 1;

    const partner = (lead.seat + 2) % 4;
    const pHas = handAt(partner, ti).some(c => ps(c) === suit && isPiece(c));
    const pGave = (t.plays ?? []).some(p => p.seat === partner && (p.cards ?? []).some(isPiece));
    if (pHas) { anyHad += 1; if (pGave) anyGave += 1; }
    if (three && pHas) {
      partnerHad += 1;
      if (pGave) {
        partnerGave += 1;
        // 交件之后，求件那一家真的把这门甩出去了吗（Glen：「对家就是可以甩牌的状态了」）
        const threw = hist.slice(ti + 1).some(t2 => {
          const l2 = t2.plays?.[0];
          return l2 && l2.seat === lead.seat && (l2.cards ?? []).length > 1 &&
            ps(l2.cards[0]) === suit;
        });
        if (threw) askerThrew += 1;
      }
    }
    // 假信号：领牌人这门其实只有这一支件，队友却把件交了出来
    if (held <= 1) { fakeLead += 1; if (pHas) { fakeHad += 1; if (pGave) fakeGave += 1; } }

    for (const seat of [0, 1, 2, 3]) {
      if (seat === lead.seat || seat === partner) continue;
      if (!handAt(seat, ti).some(c => ps(c) === suit && isPiece(c))) continue;
      oppHad += 1;
      if ((t.plays ?? []).some(p => p.seat === seat && (p.cards ?? []).some(isPiece))) oppGave += 1;
    }
  });
}
const pct = (a, b) => b ? `${(a * 100 / b).toFixed(1)}%` : '--';
console.log(`${N} 局：某门【第一次被领】就领单张件 ${askLeads} 次，其中真三求一（手上 ≥3 件）${threeOne} 次`);
console.log(`  三求一 · 队友手上确实有那支件      ${partnerHad}`);
console.log(`    队友当墩把件交出来               ${partnerGave}\t${pct(partnerGave, partnerHad)}`);
console.log(`  所有领件求件 · 队友手上有件        ${anyHad}`);
console.log(`    队友当墩把件交出来               ${anyGave}\t${pct(anyGave, anyHad)}`);
console.log(`    交件之后求件那家真的甩了这门     ${askerThrew}\t${pct(askerThrew, partnerGave)}`);
console.log(`  假信号（领牌人这门其实只有 1 件）  ${fakeLead} 次，队友手上有件 ${fakeHad}，交出来 ${fakeGave}`);
console.log(`  对照：对手手上有件而交出来的        ${oppGave}/${oppHad}\t${pct(oppGave, oppHad)}`);
