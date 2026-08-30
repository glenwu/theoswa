// Glen 2026-08-29：「BOT 现在还是容易乱砍件，特别是有 K 的时候，不考虑是谁求的件，
//   经常是即使对手求的件，有 A 或者 10 分 15 分就砍了，不考虑后果。」
//
// 口径：每一次【躲得掉却还是打出件】，先问「这门此刻是谁在求」，
// 再按 Glen 早先给的判据看合不合规：
//   两件在手 → 可以砍
//   只有一件 → 一般不能出，除非 桌上 ≥20 分，或 这门自己只剩两三支
// 再加他另一处给的例外：「即使对方甩了也得不了多少分，那么就可以杀」——
// ⚠️ 量的是这门【天生】多少分（打 10 / 打 K 时该门的 10 / K 升主，从 50 掉到 30），
// 不是「还剩多少分」。Glen 2026-08-29 纠正：甩牌的价值不局限在这一门，
// 甩长了小牌升级还能吃别门的分，所以「分被打掉了」不算安全。
// ⚠️ loose-piece.mjs 里已经有这条判据，但【只在对手赢下这墩那个分支里】用。
// 本脚本不看输赢，所有情况一律过判 —— Glen 说的正是「自己赢下这墩」那一半。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf, cardPoints } from '../../server/cards.js';

const N_ROUNDS = Number(process.env.N ?? 200);
const BASE = Number(process.env.BASE ?? 4200);

const tally = new Map();
const byTablePoints = new Map();
const add = k => tally.set(k, (tally.get(k) ?? 0) + 1);
let avoidable = 0;

for (let i = 0; i < N_ROUNDS; i++) {
  const { state } = await simulateRound({ seed: BASE + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  const { trumpSuit, rankCard } = round;
  const ps = c => playSuitOf(c, trumpSuit, rankCard);
  const isPiece = c => ps(c) !== 'TRUMP' && (c.rank === 14 || c.rank === 13) && c.rank !== rankCard;
  const pieceTotal = [14, 13].filter(r => r !== rankCard).length * 2;

  // 到第 ti 墩为止，这门出了多少张
  const playedInSuit = (suit, ti) => {
    let n = 0;
    for (let k = 0; k < ti; k++)
      for (const p of hist[k].plays ?? [])
        for (const x of p.cards ?? []) if (ps(x) === suit) n += 1;
    return n;
  };

  const handOf = (seat, ti) => {
    const out = [];
    for (let k = ti; k < hist.length; k++)
      for (const p of hist[k].plays ?? []) if (p.seat === seat) out.push(...(p.cards ?? []));
    return out;
  };

  hist.forEach((t, ti) => {
    const lead = t.plays?.[0];
    if (!lead) return;
    const n = lead.cards?.length ?? 1;
    const pts = (t.plays ?? []).flatMap(p => p.cards ?? []).reduce((s, c) => s + cardPoints(c), 0);

    for (const play of (t.plays ?? []).slice(1)) {
      const mine = play.cards ?? [];
      const pieces = mine.filter(isPiece);
      if (!pieces.length) continue;

      // 躲得掉吗（口径同 loose-piece.mjs）
      const hand = handOf(play.seat, ti);
      const inSuit = hand.filter(c => ps(c) === t.leadSuit);
      let canDodge;
      if (inSuit.length >= n) {
        canDodge = inSuit.filter(c => !isPiece(c)).length >= n;
      } else {
        const stuck = inSuit.filter(isPiece).length;
        const filler = hand.filter(c => ps(c) !== t.leadSuit);
        canDodge = stuck === 0 && filler.filter(c => !isPiece(c)).length >= (n - inSuit.length);
      }
      if (!canDodge) continue;
      avoidable += pieces.length;

      for (const piece of pieces) {
        const suit = ps(piece);
        // 这门是谁在求 —— Glen 2026-08-29：求件只算这门【第一次】被领的那一手。
        // 「同一门再打就是自己还没可以甩牌，继续捅」，不是新的求件。
        let askerTeam = null;
        for (let k = 0; k <= ti; k++) {
          if (hist[k].leadSuit !== suit) continue;
          const a = hist[k].plays?.[0]?.cards ?? [];
          if (a.length === 1 && !isPiece(a[0]) && (a[0].rank <= 5 || a[0].rank === 10)) {
            askerTeam = hist[k].leadSeat % 2;
          }
          break;   // 第一次被领的那一手就定了，后面再领都不算
        }
        let seenBefore = 0;
        for (let k = 0; k < ti; k++)
          for (const p2 of hist[k].plays ?? [])
            for (const x of p2.cards ?? []) if (ps(x) === suit && isPiece(x)) seenBefore += 1;
        const stillAsking = askerTeam !== null && seenBefore < pieceTotal;

        const who = !stillAsking ? '没人在求'
          : askerTeam === (play.seat % 2) ? '队友在求' : '对手在求';
        const label = piece.rank === 14 ? 'A' : 'K';

        if (who !== '对手在求') { add(`${who}（${label}）`); continue; }

        const heldHere = hand.filter(x => ps(x) === suit && isPiece(x)).length;
        const lenHere = hand.filter(x => ps(x) === suit).length;
        // 这门【天生】多少分：打 10 / 打 K 时该门的 10 / K 升主，从 50 掉到 30
        const suitMax = 50 - (rankCard === 5 ? 10 : (rankCard === 10 || rankCard === 13) ? 20 : 0);
        // 放行门槛按 Glen 2026-08-30 给的那张表算（源码里的 pieceAskPointsFor）：
        //   庄家一方且还没保底（要吊主）→ 30，其余 → 20；
        //   这门已出 ≥12 → 压到 15，≥16 → 压到 10。
        // ⚠️ 「还没保底」这里用近似：那一家整局没打出过鬼/主级牌就当成没保底。
        // 审计只是对口径，不用跟源码的 assessBottomControl 逐位对齐。
        const isDeclarerSide = (play.seat % 2) === (round.declarerSeat % 2);
        let topSeen = false;
        for (const h of hist)
          for (const p2 of h.plays ?? [])
            if (p2.seat === play.seat)
              for (const x of p2.cards ?? [])
                if (x.rank === 16 || x.rank === 15) topSeen = true;
        const goneHere = playedInSuit(suit, ti);
        const base = isDeclarerSide && !topSeen ? 30 : 20;
        const bar = goneHere >= 16 ? Math.min(base, 10)
          : goneHere >= 12 ? Math.min(base, 15) : base;
        const ok = heldHere >= 2 || pts >= bar || lenHere <= 3 || suitMax <= 30;
        byTablePoints.set(pts, byTablePoints.get(pts) ?? { killed: 0, spared: 0 });
        const won = t.winnerSeat === play.seat;
        if (ok) {
          add(`对手在求 · 合规（${label}）· ${heldHere >= 2 ? '我有两件' : pts >= bar ? `到线（${bar} 分）` : lenHere <= 3 ? '只剩两三支' : '这门天生就少分'}`);
        } else {
          add(`★ 对手在求 · 违规（${label}）· 桌上 ${pts} 分 · 这门 ${lenHere} 支 · ${won ? '自己赢下' : '没赢'}`);
        }
      }
    }
  });
}

console.log(`${N_ROUNDS} 局：躲得掉却还是打出的件 ${avoidable} 支`);
const rows = [...tally.entries()].sort((a, b) => b[1] - a[1]);
const bad = rows.filter(([k]) => k.startsWith('★'));
const good = rows.filter(([k]) => !k.startsWith('★'));
const sum = rs => rs.reduce((s, [, v]) => s + v, 0);
console.log(`\n【对手在求却还是把件砍了出去 —— 违规】共 ${sum(bad)} 支`);
for (const [k, v] of bad) console.log(`  ${String(v).padStart(4)}  ${k}`);
console.log(`\n其余 ${sum(good)} 支：`);
for (const [k, v] of good.slice(0, 12)) console.log(`  ${String(v).padStart(4)}  ${k}`);
