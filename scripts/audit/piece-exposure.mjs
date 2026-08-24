// 「件到底容易不容易打出来」的总账（Glen 实战反馈①）。
//
// 甩牌资格只看 canThrowByStatus：这门每一支件都 !== 'unseen'。所以不管是
// 贡献、是吃分、还是随手垫掉，只要打出去就都往对手的甩牌资格上推了一格。
// 唯一诚实的口径就是数【前中段一共亮了几支件】，以及这门是第几墩被打成全现的。
// 前中段 = 除最后 8 墩以外。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf, cardPoints } from '../../server/cards.js';

const N = Number(process.env.N ?? 400);
const BASE = Number(process.env.BASE ?? 4200);
let shown = 0, rounds = 0, throwTricks = 0, throwCards = 0, throwPoints = 0;
let allSeenAt = 0, allSeenSuits = 0;

for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: BASE + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  rounds += 1;
  const { trumpSuit, rankCard } = round;
  const ps = c => playSuitOf(c, trumpSuit, rankCard);
  const piece = c => ps(c) !== 'TRUMP' && (c.rank === 14 || c.rank === 13) && c.rank !== rankCard;

  const seen = new Map(); // suit -> 已亮几支
  hist.forEach((t, ti) => {
    if (t.leadType === 'throw') {
      throwTricks += 1;
      throwCards += t.plays?.[0]?.cards?.length ?? 0;
      throwPoints += (t.plays ?? []).flatMap(p => p.cards ?? [])
        .reduce((s, c) => s + cardPoints(c), 0);
    }
    if (hist.length - ti <= 8) return;
    for (const play of t.plays ?? []) {
      for (const c of play.cards ?? []) {
        if (!piece(c)) continue;
        shown += 1;
        const suit = ps(c);
        const n = (seen.get(suit) ?? 0) + 1;
        seen.set(suit, n);
        if (n === 4) { allSeenAt += ti + 1; allSeenSuits += 1; }
      }
    }
  });
}
console.log(`BASE=${BASE}  ${rounds} 局：前中段亮件 ${shown} 支（每局 ${(shown / rounds).toFixed(2)} 支）`);
console.log(`  一门四支件全在前中段亮完：${allSeenSuits} 门，平均在第 ${(allSeenAt / Math.max(1, allSeenSuits)).toFixed(1)} 墩`);
console.log(`  全局甩牌 ${throwTricks} 墩、${throwCards} 张、含 ${throwPoints} 分`);
