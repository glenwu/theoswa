// Glen 2026-08-29：「如果一个件可以砍 30 分或以上，砍的机率要大大上升，
//   30 分是非常多了。」
//
// 口径：每一次跟牌，如果【对手在这门求过件、还有件没现身、我手上正好有这门的件、
// 而且我躲得掉】，就记一次「要不要砍」的抉择，按【桌上已经摆着的分】分档，
// 看实际砍了没有。桌上的分不含我自己这一手 —— 我那支 K 的 10 分是付出，不是奖品。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf, cardPoints } from '../../server/cards.js';

const N_ROUNDS = Number(process.env.N ?? 200);
const BASE = Number(process.env.BASE ?? 4200);
const bins = new Map();
const bin = pts => (pts >= 30 ? '≥30' : pts >= 20 ? '20~25' : pts >= 15 ? '15' : pts >= 10 ? '10' : pts >= 5 ? '5' : '0');
const note = (pts, killed) => {
  const k = bin(pts);
  const row = bins.get(k) ?? { killed: 0, spared: 0 };
  row[killed ? 'killed' : 'spared'] += 1;
  bins.set(k, row);
};

for (let i = 0; i < N_ROUNDS; i++) {
  const { state } = await simulateRound({ seed: BASE + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  const { trumpSuit, rankCard } = round;
  const ps = c => playSuitOf(c, trumpSuit, rankCard);
  const isPiece = c => ps(c) !== 'TRUMP' && (c.rank === 14 || c.rank === 13) && c.rank !== rankCard;
  const pieceTotal = [14, 13].filter(r => r !== rankCard).length * 2;
  const handOf = (seat, ti) => {
    const out = [];
    for (let k = ti; k < hist.length; k++)
      for (const p of hist[k].plays ?? []) if (p.seat === seat) out.push(...(p.cards ?? []));
    return out;
  };

  hist.forEach((t, ti) => {
    const lead = t.plays?.[0];
    if (!lead || t.leadSuit === 'TRUMP') return;
    const suit = t.leadSuit;
    const n = lead.cards?.length ?? 1;

    for (const play of (t.plays ?? []).slice(1)) {
      const myTeam = play.seat % 2;
      // 对手在这门求过件？
      let asked = false;
      for (let k = 0; k <= ti && !asked; k++) {
        const hl = hist[k].plays?.[0];
        if (!hl || (hl.seat % 2) === myTeam) continue;
        const a = hl.cards ?? [];
        if (a.length === 1 && ps(a[0]) === suit && !isPiece(a[0]) &&
            (a[0].rank <= 5 || a[0].rank === 10)) asked = true;
      }
      if (!asked) continue;
      let seenBefore = 0;
      for (let k = 0; k < ti; k++)
        for (const p2 of hist[k].plays ?? [])
          for (const x of p2.cards ?? []) if (ps(x) === suit && isPiece(x)) seenBefore += 1;
      if (seenBefore >= pieceTotal) continue;

      const hand = handOf(play.seat, ti);
      const myPieces = hand.filter(x => ps(x) === suit && isPiece(x));
      if (myPieces.length === 0) continue;          // 手上没这门的件，谈不上抉择

      // 躲得掉吗
      const inSuit = hand.filter(c => ps(c) === suit);
      let canDodge;
      if (inSuit.length >= n) canDodge = inSuit.filter(c => !isPiece(c)).length >= n;
      else {
        const filler = hand.filter(c => ps(c) !== suit);
        canDodge = inSuit.filter(isPiece).length === 0 &&
          filler.filter(c => !isPiece(c)).length >= (n - inSuit.length);
      }
      if (!canDodge) continue;

      // 桌上已有的分（不含我这一手）
      let pts = 0;
      for (const p2 of t.plays ?? []) {
        if (p2.seat === play.seat) continue;
        for (const x of p2.cards ?? []) pts += cardPoints(x);
      }
      note(pts, (play.cards ?? []).some(isPiece));
    }
  });
}

const order = ['0', '5', '10', '15', '20~25', '≥30'];
console.log(`${N_ROUNDS} 局：「对手在求这门、我手上有件、又躲得掉」的抉择`);
console.log('桌上分\t砍了\t留住\t砍的比例');
for (const k of order) {
  const r = bins.get(k);
  if (!r) continue;
  const n = r.killed + r.spared;
  console.log(`${k}\t${r.killed}\t${r.spared}\t${(r.killed * 100 / n).toFixed(0)}%`);
}
