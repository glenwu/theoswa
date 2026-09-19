// Glen 2026-09-19：「自己没有件一般不能打 5 及 5 以下，队友一般会认为要求件，
//   已经发生很多次让队友把件打出来让其它人甩的问题了。」
//
// 口径：某门【第一次被领】、领的是单张非件 ≤5 或 10（= 会被读成求件），
// 按领牌人当时这门手上有没有件分两组；再看队友当墩交没交件、交了之后对手甩没甩这门。
// 修之前（300 局）：0 件组 42 次，队友有件 32 次、32 次当墩交件，其后对手甩了 9 次
//（甩牌墩 310 分）。修之后 0 次；有件组 437 → 440，没被误伤。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf, buildDeck } from '../../server/cards.js';

const N = Number(process.env.N ?? 300);
const BASE = Number(process.env.BASE ?? 4200);
const tally = {};
const bump = (k, d = 1) => { tally[k] = (tally[k] ?? 0) + d; };

for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: BASE + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  const { trumpSuit, rankCard } = round;
  const ps = c => playSuitOf(c, trumpSuit, rankCard);
  const isPiece = c => ps(c) !== 'TRUMP' && (c.rank === 13 || c.rank === 14) && c.rank !== rankCard;
  const start = new Map(state.players.map(p => [p.seat, [
    ...p.hand, ...hist.flatMap(t => (t.plays ?? []).filter(x => x.seat === p.seat).flatMap(x => x.cards)),
  ]]));
  // ⚠️ 碾压收尾（DOMINANCE）直接把四家手牌清空、补一个 plays 为空的 virtual 墩，
  // 剩下那些牌【从局末状态里还原不出是谁的】。踩过：领牌人手上的 ♠K 就在里面，
  // 被误判成「0 件乱求」。所以凡是这门还有下落不明的件，这一领归「不详」，不进两组。
  const accounted = new Set([
    ...(round.kitty ?? []), ...[...start.values()].flat(),
  ].map(c => c.id));
  const lost = buildDeck().filter(c => !accounted.has(c.id));
  const handAt = (seat, ti) => {
    const gone = new Set();
    for (let k = 0; k < ti; k++)
      for (const p of hist[k].plays ?? []) if (p.seat === seat) for (const c of p.cards ?? []) gone.add(c.id);
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
    if (!first || cards.length !== 1) return;
    const card = cards[0];
    if (isPiece(card) || !(card.rank <= 5 || card.rank === 10)) return;
    const holds = handAt(lead.seat, ti).some(c => ps(c) === suit && isPiece(c));
    if (!holds && lost.some(c => ps(c) === suit && isPiece(c))) { bump('unknown'); return; }
    const key = holds ? 'has' : 'zero';
    bump(`${key}:leads`);
    const partner = (lead.seat + 2) % 4;
    if (!handAt(partner, ti).some(c => ps(c) === suit && isPiece(c))) return;
    bump(`${key}:partnerHad`);
    if (!(t.plays ?? []).some(p => p.seat === partner && (p.cards ?? []).some(isPiece))) return;
    bump(`${key}:partnerGave`);
    const oppThrows = hist.slice(ti + 1).filter(t2 => {
      const l = t2.plays?.[0];
      return l && l.seat % 2 !== lead.seat % 2 && (l.cards ?? []).length > 1 && ps(l.cards[0]) === suit;
    });
    if (oppThrows.length) {
      bump(`${key}:oppThrew`);
      bump(`${key}:oppThrewPts`, oppThrows.reduce((s, t2) => s + (t2.points ?? 0), 0));
    }
  });
}
const pct = (a, b) => (b ? `${((a * 100) / b).toFixed(1)}%` : '--');
console.log(`（碾压收尾局里还原不出手上有没有件的 ${tally.unknown ?? 0} 次，不计入）`);
for (const key of ['zero', 'has']) {
  const L = tally[`${key}:leads`] ?? 0, H = tally[`${key}:partnerHad`] ?? 0, G = tally[`${key}:partnerGave`] ?? 0;
  console.log(
    `${key === 'zero' ? '这门 0 件' : '这门有件'}：第一次领 ≤5/10 共 ${L} 次；队友有件 ${H}，当墩交件 ${G}（${pct(G, H)}）；` +
    `交件后对手甩了这门 ${tally[`${key}:oppThrew`] ?? 0} 次（甩牌墩 ${tally[`${key}:oppThrewPts`] ?? 0} 分）`
  );
}
