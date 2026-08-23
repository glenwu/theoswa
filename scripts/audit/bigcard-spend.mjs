// 复核：大鬼 / 小鬼 / 主级牌 / 副件（副牌花色里仍是副牌的 A、K）这四类大牌，
// 每一次打出去换回了什么。Glen：「它们是大牌，也兼顾着威胁和牵制，需要谨慎打出。」
//
// 分类（只看公开信息，能从 trickHistory 完全重建）：
//   白打   —— 这一墩一分没有，而且自己这方还没赢下 → 纯浪费
//   贱卖   —— 赢了，但这一墩不到 10 分
//   划算   —— 赢了且 ≥10 分，或者这一墩本来有分被自己护住
//   被迫   —— 手上这一门只剩它了（跟牌规则逼的）
import { simulateRound } from '../../server/simulate-bots.js';
import { cardPoints, playSuitOf } from '../../server/cards.js';

const N = Number(process.env.N ?? 400);
const kinds = ['大鬼', '小鬼', '主级牌', '副件'];
const tally = {};
for (const k of kinds) tally[k] = { 白打: 0, 贱卖: 0, 划算: 0, 总计: 0, 前中段白打: 0 };

for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: 4200 + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  const { trumpSuit, rankCard } = round;
  const kindOf = card => {
    if (card.rank === 16) return '大鬼';
    if (card.rank === 15) return '小鬼';
    if (card.rank === rankCard && card.suit === trumpSuit) return '主级牌';
    if (playSuitOf(card, trumpSuit, rankCard) !== 'TRUMP' &&
        (card.rank === 14 || card.rank === 13) && card.rank !== rankCard) return '副件';
    return null;
  };
  hist.forEach((t, k) => {
    const points = (t.plays ?? []).flatMap(p => p.cards ?? [])
      .reduce((s, c) => s + cardPoints(c), 0);
    for (const play of t.plays ?? []) {
      const won = t.winnerSeat !== undefined && t.winnerSeat % 2 === play.seat % 2;
      for (const card of play.cards ?? []) {
        const kind = kindOf(card);
        if (!kind) continue;
        const row = tally[kind];
        row.总计 += 1;
        if (points === 0 && !won) {
          row.白打 += 1;
          if (hist.length - k > 4) row.前中段白打 += 1;
        } else if (won && points < 10) row.贱卖 += 1;
        else row.划算 += 1;
      }
    }
  });
}
console.log(`${N} 局，四类大牌的出牌去向：\n`);
console.log('类别      总计   白打(0分且没赢)  其中前中段   贱卖(赢但<10分)   划算');
for (const k of kinds) {
  const r = tally[k];
  const pct = n => `${(n / Math.max(1, r.总计) * 100).toFixed(0)}%`;
  console.log(`${k.padEnd(8)}${String(r.总计).padStart(5)}${String(r.白打).padStart(12)} ${pct(r.白打).padStart(5)}${String(r.前中段白打).padStart(11)}${String(r.贱卖).padStart(14)} ${pct(r.贱卖).padStart(5)}${String(r.划算).padStart(9)}`);
}
