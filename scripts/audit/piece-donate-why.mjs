// 「有得选却还是把件交出去」的决策，到底是被哪条规则推出去的？
// 在 chooseFollowCards 的出口插桩，把当时的判据一并打出来：
//   probe   —— partnerProbe（队友求件 → 贡献加分）
//   waive   —— pieceExposureRisk 被豁免（豁免了就没有亮件代价）
//   which   —— 哪一条豁免：allSeen / near3 / strong / asked / nearVoid
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const F = 'server/bot-policy.js';
const src = fs.readFileSync(F, 'utf8');
const restore = () => fs.writeFileSync(F, src);
process.on('SIGINT', () => { restore(); process.exit(130); });
process.on('SIGTERM', () => { restore(); process.exit(143); });

const OLD = `  return choices
    .sort((a, b) =>
      (b.score + (priorBonus.get(b) ?? 0)) - (a.score + (priorBonus.get(a) ?? 0)) ||
      a.cards[0].id.localeCompare(b.cards[0].id)
    )[0].cards;
}`;
const SHIM = `
// teamAskedPieceBefore 已删（2026-08-29：求件只算这门第一次被领的那一手，
// 那个判断变成恒为假）。这里改用同源的新判据。
const __asked = (v, c, su) =>
  typeof suitLedBefore === 'function' ? suitLedBefore(v, su) : false;
`;
const NEW = `  const __ranked = choices
    .sort((a, b) =>
      (b.score + (priorBonus.get(b) ?? 0)) - (a.score + (priorBonus.get(a) ?? 0)) ||
      a.cards[0].id.localeCompare(b.cards[0].id)
    );
  const __pick = __ranked[0];
  const __isP = c => suitOf(c, ctx) === lead.playSuit && isSidePiece(c, ctx);
  if (__pick && __pick.cards.some(__isP)) {
    const alt = __ranked.filter(p => !p.cards.some(__isP));
    if (alt.length > 0) {
      const suit = lead.playSuit;
      const you = view.you;
      const probe = lead.seat === partnerSeatOf(you.seat) && isPieceRequestLead(lead.cards, ctx);
      const fresh = probe && !__asked(view, ctx, suit, you.team);
      const pv = view.round?.piecesView?.[suit] ?? [];
      const hidden = pv.filter(i => i.status === 'unseen').length;
      const held = pv.filter(i => i.status === 'mine').length;
      const spent = __pick.cards.filter(c => suitOf(c, ctx) === suit).length;
      const which =
        hidden === 0 ? 'allSeen'
        : held >= 3 && hidden === 1 ? 'near3'
        : strongPieceSuit(view, ctx, suit) ? 'strong'
        : cardsOfSuit(you.hand, suit, ctx).length - spent <= PIECE_NEAR_VOID_AFTER ? 'nearVoid'
        : 'none';
      const pts = [...view.round.currentTrick, { seat: you.seat, cards: __pick.cards }]
        .flatMap(p => p.cards).reduce((n, c) => n + cardPoints(c), 0);
      const led = trickLeader(
        [...view.round.currentTrick, { seat: you.seat, cards: __pick.cards }], ctx);
      console.error('PD ' + JSON.stringify({
        probe, fresh, which,
        askedBefore: __asked(view, ctx, suit, you.team),
        gap: Math.round(__pick.score - alt[0].score),
        hand: you.hand.length, pts,
        wins: led?.seat % 2 === you.team,
        behind: 3 - view.round.currentTrick.length,
      }));
    }
  }
  return __pick.cards;
}
${SHIM}`;
try {
  if (!src.includes(OLD)) throw new Error('锚点没对上');
  fs.writeFileSync(F, src.replace(OLD, NEW));
  execFileSync('node', ['scripts/audit/piece-ask-repeat.mjs'], {
    env: { ...process.env, N: process.env.N ?? '400' },
    encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'],
  });
} catch (err) {
  process.stderr.write(String(err.stderr ?? err.message ?? err));
} finally {
  restore();
}
