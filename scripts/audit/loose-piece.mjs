// Glen 实战反馈③：「再次强调件不能乱出，经常看到 BOT 乱出件，
//                   使得这门牌非常容易被甩。」
//
// 口径只认【躲得掉却没躲】：把每一次跟牌还原成「当时合法的选择集」，
// 问一句「这一手能不能一支件都不出」。能，却还是出了 → 记账。
// 再按这一支件换回了什么分类：赢了这一墩拿到多少分 / 白扔。
//
// 合法性按 trick.js：
//   手上该门 ≥N → 从该门里自选 N 张
//   手上该门 1..N-1 → 该门全出，其余任意补齐
//   手上该门 0 → 任意 N 张
// 当时手上有哪些牌 = 该家从这一墩起往后打出的所有牌（牌只会变少，还原是准的）。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf, cardPoints } from '../../server/cards.js';

const N_ROUNDS = Number(process.env.N ?? 200);
const BASE = Number(process.env.BASE ?? 4200);

let played = 0, forced = 0, avoidable = 0;
const bucket = new Map();
const add = (k) => bucket.set(k, (bucket.get(k) ?? 0) + 1);

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
      for (const p of hist[k].plays ?? [])
        if (p.seat === seat) out.push(...(p.cards ?? []));
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
      played += pieces.length;

      const hand = handOf(play.seat, ti);
      const inSuit = hand.filter(c => ps(c) === t.leadSuit);
      let canDodge;
      if (inSuit.length >= n) {
        canDodge = inSuit.filter(c => !isPiece(c)).length >= n;
      } else {
        // 该门必须全出 —— 里边的件躲不掉；只看补齐的那几张躲不躲得掉
        const stuck = inSuit.filter(isPiece).length;
        const fillerNeed = n - inSuit.length;
        const filler = hand.filter(c => ps(c) !== t.leadSuit);
        canDodge = stuck === 0 && filler.filter(c => !isPiece(c)).length >= fillerNeed;
      }
      if (!canDodge) { forced += pieces.length; continue; }
      avoidable += pieces.length;

      const won = t.winnerSeat === play.seat;
      const teamWon = (t.winnerSeat % 2) === (play.seat % 2);
      const label = pieces.length > 1 ? `${pieces.length} 支` : (pieces[0].rank === 14 ? 'A' : 'K');
      if (won) {
        if (pts >= 20) add(`自己赢下这墩、拿到 ≥20 分（${label}）`);
        else if (pts >= 10) add(`自己赢下这墩、拿到 10~15 分（${label}）`);
        else if (pts > 0) add(`自己赢下这墩、只拿到 5 分（${label}）`);
        else add(`自己赢下这墩、一分没有（${label}）`);
      } else if (teamWon) {
        // 队友已经赢了，把 K 的 10 分送过去是【对的】；A 是 0 分，纯亮件
        add(pieces.some(c => c.rank === 14)
          ? `队友赢下这墩，我把 A 亮了出去（0 分，纯亏）`
          : `队友赢下这墩，我把 K 的 10 分送过去（这是对的）`);
      } else {
        const followed0 = true;
        const followed = ps(pieces[0]) === t.leadSuit;
        const winCards = (t.plays ?? []).find(p => p.seat === t.winnerSeat)?.cards ?? [];
        const trumped = winCards.length > 0 && ps(winCards[0]) === 'TRUMP' && t.leadSuit !== 'TRUMP';
        const oppThrow = (lead.cards?.length ?? 1) > 1 && t.leadSuit !== 'TRUMP' &&
          (lead.seat % 2) !== (play.seat % 2);
        if (oppThrow) add('★ 对手正在甩牌，我把件垫了进去');
        // Glen 再次强调的那条：对手【还在求这门】的时候把件交出去。
        // 「还在求」跨墩有效：他先前在这门求过、而且这门还有件没现身。
        for (const piece of pieces) {
          const suit = ps(piece);
          let asked = false;
          for (let k = 0; k <= ti && !asked; k++) {
            const hl = hist[k].plays?.[0];
            if (!hl || (hl.seat % 2) === (play.seat % 2)) continue;
            const a = hl.cards ?? [];
            if (a.length === 1 && ps(a[0]) === suit && !isPiece(a[0]) &&
                (a[0].rank <= 5 || a[0].rank === 10)) asked = true;
          }
          if (!asked) continue;
          let seenBefore = 0;
          for (let k = 0; k < ti; k++)
            for (const p2 of hist[k].plays ?? [])
              for (const x of p2.cards ?? []) if (ps(x) === suit && isPiece(x)) seenBefore += 1;
          if (seenBefore >= pieceTotal) continue;   // 件已经全现，不存在「还在求」
          add(`★ 对手还在求这门，我把件交了出去（这墩 ${pts >= 20 ? '≥20' : pts} 分）`);
        }
        if (!followed) {
          // 垫掉件的时候，手上【别的】非件牌都是些什么？
          const rest = hand.filter(c => !mine.includes(c) && !isPiece(c));
          const kinds = [];
          if (rest.some(c => ps(c) !== 'TRUMP' && cardPoints(c) === 0)) kinds.push('还有无分小副牌');
          else if (rest.some(c => ps(c) !== 'TRUMP')) kinds.push('剩下的副牌都带分');
          else kinds.push('剩下的全是主牌');
          add(`垫牌位置垫件 —— ${kinds[0]}`);
        } else add(trumped ? '跟这门时被对手用主牌毙了' : '跟这门时被对手更大的牌压了');
      }
    }
  });
}

const pct = n => `${(n * 100 / played).toFixed(1)}%`;
console.log(`${N_ROUNDS} 局：跟牌位置一共打出件 ${played} 支`);
console.log(`  躲不掉（该门必须全出 / 手上只剩件）  ${forced}\t${pct(forced)}`);
console.log(`  躲得掉却还是出了                      ${avoidable}\t${pct(avoidable)}`);
console.log('\n躲得掉的那些换回了什么：');
[...bucket.entries()].sort((a, b) => b[1] - a[1])
  .forEach(([k, v]) => console.log(`  ${String(v).padStart(5)}  ${(v * 100 / avoidable).toFixed(1).padStart(5)}%  ${k}`));
