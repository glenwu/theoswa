// Glen 实战反馈④：「有时候 bot 求完件，我给它之后，它却不想甩，
//                   变成一张张打，浪费了机会」。
//
// 口径：每一次电脑【领牌】的机会，逐门副牌问一句
//   「这门此刻甩得出去吗」= 这门的每一支件要么已经现身、要么在我手上
//    （canThrowByStatus 的等价还原）+ 我这门还有 ≥2 张。
// 甩得出去却没甩 = 浪费。再按「这一门我方先前求过件没有」分两栏，
// 求过的那一栏就是 Glen 说的那种场面。
//
// 当时手上有哪些牌 = 该家从这一墩起往后打出的所有牌（牌只会变少，还原是准的）。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf } from '../../server/cards.js';

const N = Number(process.env.N ?? 400);
const BASE = Number(process.env.BASE ?? 4200);

let chances = 0, threw = 0, singleSameSuit = 0, ledElsewhere = 0;
let askedChances = 0, askedThrew = 0, askedSingle = 0, askedElse = 0;
const missByLen = new Map();

for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: BASE + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  const { trumpSuit, rankCard } = round;
  const ps = c => playSuitOf(c, trumpSuit, rankCard);
  const isPiece = c => ps(c) !== 'TRUMP' && (c.rank === 14 || c.rank === 13) && c.rank !== rankCard;
  const suits = ['S', 'H', 'D', 'C'].filter(s => s !== trumpSuit);
  // 这门一共有几支件：A/K 各两张，级牌那一档升主就不算件了
  const pieceTotal = [14, 13].filter(r => r !== rankCard).length * 2;

  // 还原某家在第 ti 墩开始时手上属于 suit 的牌
  const handOf = (seat, ti, suit) => {
    const out = [];
    for (let k = ti; k < hist.length; k++)
      for (const p of hist[k].plays ?? [])
        if (p.seat === seat) for (const x of p.cards ?? []) if (ps(x) === suit) out.push(x);
    return out;
  };

  hist.forEach((t, ti) => {
    const lead = t.plays?.[0];
    if (!lead) return;
    for (const suit of suits) {
      const mine = handOf(lead.seat, ti, suit);
      if (mine.length < 2) continue;
      // 已现身的件（前面各墩打出去的）
      let seen = 0;
      for (let k = 0; k < ti; k++)
        for (const p of hist[k].plays ?? [])
          for (const x of p.cards ?? []) if (ps(x) === suit && isPiece(x)) seen += 1;
      const held = mine.filter(isPiece).length;
      if (seen + held < pieceTotal) continue;      // 还有件没现身 → 甩不了
      chances += 1;

      // 我方（自己或对家）先前在这门求过件吗
      let asked = false;
      for (let k = 0; k < ti && !asked; k++) {
        const hl = hist[k].plays?.[0];
        if (!hl || (hl.seat % 2) !== (lead.seat % 2)) continue;
        const a = hl.cards ?? [];
        if (a.length === 1 && ps(a[0]) === suit && !isPiece(a[0]) &&
            (a[0].rank <= 5 || a[0].rank === 10)) asked = true;
      }
      if (asked) askedChances += 1;

      const didThrow = t.leadType === 'throw' && t.leadSuit === suit;
      const sameSuit = ps(lead.cards?.[0] ?? {}) === suit;
      if (didThrow) { threw += 1; if (asked) askedThrew += 1; }
      else if (sameSuit) {
        singleSameSuit += 1; if (asked) askedSingle += 1;
        missByLen.set(mine.length, (missByLen.get(mine.length) ?? 0) + 1);
      } else { ledElsewhere += 1; if (asked) askedElse += 1; }
    }
  });
}

const pct = (a, b) => b ? `${(a * 100 / b).toFixed(1)}%` : '--';
console.log(`${N} 局，「这门此刻甩得出去」的领牌机会 ${chances} 次`);
console.log(`  甩了            ${threw}\t${pct(threw, chances)}`);
console.log(`  只领一张（同门）${singleSameSuit}\t${pct(singleSameSuit, chances)}  ← Glen 说的浪费`);
console.log(`  改领别门        ${ledElsewhere}\t${pct(ledElsewhere, chances)}`);
console.log(`\n其中【我方先前在这门求过件】的 ${askedChances} 次：`);
console.log(`  甩了            ${askedThrew}\t${pct(askedThrew, askedChances)}`);
console.log(`  只领一张（同门）${askedSingle}\t${pct(askedSingle, askedChances)}`);
console.log(`  改领别门        ${askedElse}\t${pct(askedElse, askedChances)}`);
console.log(`\n「只领一张」按这门手上张数分布：`);
[...missByLen.entries()].sort((a, b) => a[0] - b[0])
  .forEach(([len, n]) => console.log(`  ${len} 张\t${n}`));
