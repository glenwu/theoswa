// Glen：「对手在求某一门牌，正常来说我们这边不能帮他们求，也就是说一般不主动
//   打这个花色，让他们出，因为这样我方是有优势的，他们出牌我方会最后下。」
//
// 口径：每一次【领牌】，如果领的那门正好是对手求过、而且这门还有件没现身，
// 就记一次「帮对手求了」。再分栏看这门自己有没有甩牌欲望 —— 有的话是自己的
// 武器，不算帮忙。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf } from '../../server/cards.js';

const N = Number(process.env.N ?? 200);
const BASE = Number(process.env.BASE ?? 4200);
let leads = 0, helped = 0, helpedWithAmbition = 0;
const byLen = new Map();

for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: BASE + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  const { trumpSuit, rankCard } = round;
  const ps = c => playSuitOf(c, trumpSuit, rankCard);
  const isPiece = c => ps(c) !== 'TRUMP' && (c.rank === 14 || c.rank === 13) && c.rank !== rankCard;
  const pieceTotal = [14, 13].filter(r => r !== rankCard).length * 2;

  hist.forEach((t, ti) => {
    const lead = t.plays?.[0];
    if (!lead || t.leadSuit === 'TRUMP') return;
    leads += 1;
    const suit = t.leadSuit;
    // 对手先前在这门求过吗（我方没求过 —— 我方求过就归「帮队友」那条）
    let oppAsked = false, weAsked = false;
    for (let k = 0; k < ti; k++) {
      const hl = hist[k].plays?.[0];
      if (!hl) continue;
      const a = hl.cards ?? [];
      if (a.length !== 1 || ps(a[0]) !== suit || isPiece(a[0])) continue;
      if (!(a[0].rank <= 5 || a[0].rank === 10)) continue;
      if ((hl.seat % 2) === (lead.seat % 2)) weAsked = true; else oppAsked = true;
    }
    if (!oppAsked || weAsked) return;
    let seen = 0;
    for (let k = 0; k < ti; k++)
      for (const p of hist[k].plays ?? [])
        for (const x of p.cards ?? []) if (ps(x) === suit && isPiece(x)) seen += 1;
    if (seen >= pieceTotal) return;   // 件已经逼完，领这门不算帮他求
    helped += 1;
    // 这门我当时有多长（还原：从这一墩起往后打出的这门牌）
    let len = 0;
    for (let k = ti; k < hist.length; k++)
      for (const p of hist[k].plays ?? [])
        if (p.seat === lead.seat) for (const x of p.cards ?? []) if (ps(x) === suit) len += 1;
    byLen.set(len, (byLen.get(len) ?? 0) + 1);
    if (len >= 6) helpedWithAmbition += 1;
  });
}

console.log(`${N} 局：领副牌共 ${leads} 次`);
console.log(`  领的正好是【对手求过、件还没逼完】的那门  ${helped}\t${(helped * 100 / leads).toFixed(1)}%`);
console.log(`    其中这门自己有 ≥6 张（算自己的武器，不亏）  ${helpedWithAmbition}`);
console.log(`    其余 ${helped - helpedWithAmbition} 次是纯帮他逼件`);
console.log('  按当时这门张数：', [...byLen.entries()].sort((a, b) => a[0] - b[0])
  .map(([k, v]) => `${k}张:${v}`).join('  '));
