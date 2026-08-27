// Glen：「第三家的出牌，在保证不乱出鬼、主2 或是件的前提，还是要尽量吃大一些，
//   避免第四家容易吃分。比如前两家都是小于 10 的，第三家还是尽量吃 10 以上，
//   不然第四家就容易用 10 吃分。」
//
// 口径：我是第三家（前面已经两手）、首家领的是单张副牌、前两手都没到 10，
// 而我手上有【非件、非主】的 J/Q 能压住场面 —— 也就是 Glen 说的那种「打得起、
// 又不用动鬼/主2/件」的牌。看电脑到底打没打。
//
// ⚠️ 只数【封得住】的候选：J/Q。A/K 是件，鬼和主 2 是保底本钱，
// 那三样他明说了是前提条件，不在这条账里。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf, cardPoints, cardStrength } from '../../server/cards.js';

const N = Number(process.env.N ?? 200);
let chances = 0, sealed = 0, playedSmall = 0;
const lost = new Map();

for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: 4200 + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  const { trumpSuit, rankCard } = round;
  const ctx = { trumpSuit, rankCard };
  const ps = c => playSuitOf(c, trumpSuit, rankCard);
  const isPiece = c => ps(c) !== 'TRUMP' && (c.rank === 14 || c.rank === 13) && c.rank !== rankCard;

  const handOf = (seat, ti) => {
    const out = [];
    for (let k = ti; k < hist.length; k++)
      for (const p of hist[k].plays ?? [])
        if (p.seat === seat) out.push(...(p.cards ?? []));
    return out;
  };

  hist.forEach((t, ti) => {
    const plays = t.plays ?? [];
    if (plays.length !== 4) return;
    const lead = plays[0];
    if (t.leadSuit === 'TRUMP' || (lead.cards?.length ?? 1) !== 1) return;
    const third = plays[2];
    if (!third) return;
    // 前两手都跟了这门、而且都小于 10
    const firstTwo = plays.slice(0, 2);
    if (!firstTwo.every(p => (p.cards ?? []).length === 1 && ps(p.cards[0]) === t.leadSuit)) return;
    if (!firstTwo.every(p => p.cards[0].rank < 10)) return;
    // 第四家是对手（第三家的对家是第一家，第四家才是要防的那个）
    if ((plays[3].seat % 2) === (third.seat % 2)) return;

    const hand = handOf(third.seat, ti).filter(c => ps(c) === t.leadSuit);
    // 手上非件的 J/Q（压得过 10、又不动件）
    const sealers = hand.filter(c => !isPiece(c) && (c.rank === 11 || c.rank === 12));
    if (sealers.length === 0) return;
    chances += 1;
    const mine = third.cards?.[0];
    const usedSealer = mine && (mine.rank === 11 || mine.rank === 12) && !isPiece(mine);
    const usedBigger = mine && cardStrength(mine, ctx) >= cardStrength(sealers[0], ctx);
    if (usedSealer || usedBigger) { sealed += 1; return; }
    playedSmall += 1;
    if (process.env.SHOW && playedSmall <= Number(process.env.SHOW)) {
      const lbl = c => `${ps(c)}${c.rank}`;
      console.log(JSON.stringify({
        主: trumpSuit, 打: rankCard, 领: t.leadSuit,
        桌面: plays.slice(0, 2).map(p => lbl(p.cards[0])),
        我打: lbl(mine), 我这门手牌: hand.map(lbl),
        全部手牌: handOf(third.seat, ti).map(lbl),
        第四家: lbl(plays[3].cards[0]), 赢家: t.winnerSeat, 我是: third.seat,
        件表: (round.piecesView?.[t.leadSuit] ?? []).map(x => `${x.rank}:${x.status}`),
      }));
    }
    // 第四家用什么拿走的、拿走多少分
    const winner = plays.find(p => p.seat === t.winnerSeat);
    const pts = plays.flatMap(p => p.cards ?? []).reduce((s, c) => s + cardPoints(c), 0);
    const stolen = t.winnerSeat === plays[3].seat;
    lost.set(stolen ? `第四家拿走了（${pts} 分）` : '第四家没拿走',
      (lost.get(stolen ? `第四家拿走了（${pts} 分）` : '第四家没拿走') ?? 0) + 1);
  });
}

const pct = n => chances ? `${(n * 100 / chances).toFixed(1)}%` : '--';
console.log(`${N} 局：第三家「前两手都不到 10、手上有非件的 J/Q」共 ${chances} 次`);
console.log(`  封了（打 J/Q 或更大）  ${sealed}\t${pct(sealed)}`);
console.log(`  还是打了小牌          ${playedSmall}\t${pct(playedSmall)}`);
console.log('  打小牌之后的结果：');
[...lost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
  .forEach(([k, v]) => console.log(`    ${String(v).padStart(4)}  ${k}`));
