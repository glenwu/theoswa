// Glen 实战反馈①：「bot 会乱求牌」。
//
// 约定是：单张、非件、rank ≤5 或 =10 的副牌领牌 = 求件（isPieceRequestLead）。
// 真人读的是【这个信号】，不是电脑心里的动机。所以口径只能是：
//   电脑一共发出去多少次这个信号，其中有多少次那门牌【根本没有甩牌欲望】。
// 甩牌欲望按 Glen 的说法两条任一：件多、或者很长。
//
// 当时手上那门有多少张 = 该家从这一墩起往后打出的、属于这门的所有牌
// （含领出去这张）—— 牌只会变少，这个还原是准的。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf } from '../../server/cards.js';

const N = Number(process.env.N ?? 400);
const BASE = Number(process.env.BASE ?? 4200);
const LONG = Number(process.env.LONG ?? 6);   // 「很长」暂按 6 张，待 Glen 确认
let signals = 0, withPiece = 0, longNoPiece = 0, helping = 0, junk = 0;
const byLen = new Map();

for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: BASE + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  const { trumpSuit, rankCard } = round;
  const ps = c => playSuitOf(c, trumpSuit, rankCard);
  const piece = c => ps(c) !== 'TRUMP' && (c.rank === 14 || c.rank === 13) && c.rank !== rankCard;

  hist.forEach((t, ti) => {
    const lead = t.plays?.[0];
    if (!lead || t.leadType === 'throw') return;
    const cards = lead.cards ?? [];
    if (cards.length !== 1) return;
    const c = cards[0];
    const suit = ps(c);
    if (suit === 'TRUMP' || piece(c)) return;
    if (!(c.rank <= 5 || c.rank === 10)) return;   // 不是求件信号
    signals += 1;

    // 队友先前在这门求过件、且还有件没现完 → 这是「帮队友逼件」（Glen 第 2 条），
    // 不算乱求：这时候本来就该领这门，我这门有多短都不影响。
    const mate = (lead.seat + 2) % 4;
    let assisting = false;
    for (let k = 0; k < ti; k++) {
      const h = hist[k], hl = h.plays?.[0];
      if (!hl || h.leadSeat !== mate || ps(hl.cards?.[0] ?? {}) !== suit) continue;
      const a = hl.cards ?? [];
      if (a.length === 1 && !piece(a[0]) && (a[0].rank <= 5 || a[0].rank === 10)) assisting = true;
    }
    if (assisting) { helping += 1; return; }

    // 还原领牌那一刻，他手上这门有几张、其中几支件
    let len = 0, pieces = 0;
    for (let k = ti; k < hist.length; k++) {
      for (const p of hist[k].plays ?? []) {
        if (p.seat !== lead.seat) continue;
        for (const x of p.cards ?? []) {
          if (ps(x) !== suit) continue;
          len += 1;
          if (piece(x)) pieces += 1;
        }
      }
    }
    byLen.set(len, (byLen.get(len) ?? 0) + 1);
    if (pieces >= 1) withPiece += 1;
    else if (len >= LONG) longNoPiece += 1;
    else junk += 1;
  });
}

const pct = n => `${(n / signals * 100).toFixed(1)}%`;
console.log(`BASE=${BASE}  ${N} 局：真人会读成「求件」的领牌共 ${signals} 次`);
console.log(`  ① 这门自己有件（件多 → 求得有理）        ${String(withPiece).padStart(5)}  ${pct(withPiece)}`);
console.log(`  ② 无件但够长（≥${LONG} 张 → 想甩，也算有理） ${String(longNoPiece).padStart(5)}  ${pct(longNoPiece)}`);
console.log(`  ③ 帮队友逼件（他求过、件还没现完）        ${String(helping).padStart(5)}  ${pct(helping)}`);
console.log(`  ④ 无件、不长、也不是帮队友 → 【乱求】     ${String(junk).padStart(5)}  ${pct(junk)}`);
console.log('  按当时这门的张数分布：',
  [...byLen.entries()].sort((a,b)=>a[0]-b[0]).map(([k,v])=>`${k}张:${v}`).join('  '));
