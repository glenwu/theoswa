// 「垫牌里白扔了多少大牌」—— 一个不受轨迹漂移干扰的质量指标。
//
// 口径：这一手【参与不了比大小】（既非满额跟花色，也非满额主牌毙，主牌墩则是
// 主牌不满额），那它一分也换不回来。分两档看：
//   鬼 / 主级牌 —— 只要出现在垫牌里就是纯浪费，本来该留着保底/撬底
//   副件（A/K）—— 只有【垫进我方没赢下的那一墩】才算浪费；
//                 垫给已经赢下的队友是正常走分，不能算亏
// 前中段 = 除最后 8 墩以外，那才是大牌真正有威胁价值的阶段。
// 用法：BASE=<种子基数> node scripts/audit/discard-waste.mjs，两个版本各跑一次再比。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf } from '../../server/cards.js';

const N = Number(process.env.N ?? 400);
const BASE = Number(process.env.BASE ?? 4200);
const tally = { 鬼: 0, 主级牌: 0, 副A: 0, 副K: 0 };
let plays = 0;

for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: BASE + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  const { trumpSuit, rankCard } = round;
  const ps = c => playSuitOf(c, trumpSuit, rankCard);

  hist.forEach((t, ti) => {
    if (hist.length - ti <= 8) return;          // 只看前中段
    const all = t.plays ?? [];
    const lead = all[0];
    if (!lead) return;
    const leadSuit = lead.playSuit ?? ps(lead.cards[0]);
    const n = lead.cards.length;
    for (const play of all.slice(1)) {
      const suited = play.cards.filter(c => ps(c) === leadSuit).length;
      const trumps = play.cards.filter(c => ps(c) === 'TRUMP').length;
      const contends = leadSuit === 'TRUMP' ? trumps === n : (suited === n || trumps === n);
      if (contends) continue;
      plays += 1;
      const teamWon = t.winnerSeat !== undefined && t.winnerSeat % 2 === play.seat % 2;
      for (const c of play.cards) {
        if (c.rank === 15 || c.rank === 16) tally.鬼 += 1;
        else if (c.rank === rankCard && c.suit === trumpSuit) tally.主级牌 += 1;
        else if (ps(c) !== 'TRUMP' && (c.rank === 14 || c.rank === 13) &&
                 c.rank !== rankCard && !teamWon) tally[c.rank === 14 ? '副A' : '副K'] += 1;
      }
    }
  });
}
const pct = n => `${(n / Math.max(1, plays) * 100).toFixed(1)}%`;
console.log(`BASE=${BASE}  前中段垫牌手 ${plays}：` +
  `鬼 ${tally.鬼}（${pct(tally.鬼)}）  主级牌 ${tally.主级牌}（${pct(tally.主级牌)}）  ` +
  `副A 垫给对手 ${tally.副A}（${pct(tally.副A)}）  副K 垫给对手 ${tally.副K}（${pct(tally.副K)}）`);
