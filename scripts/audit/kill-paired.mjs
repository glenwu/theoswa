// 毙牌的两件事，逐局配对量（同一批种子，两个版本各跑一次再 diff）：
//   1. 浪费型毙牌：毙一手多张时一次交出【两张以上顶牌】（鬼 / 主级牌）——
//      判牌只比最大那一张，多交的那些纯属浪费。Glen 实战反馈的就是这个。
//   2. grab：底有没有被撬。毙牌花的是主牌，而主牌正是撑着底的东西。
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf } from '../../server/cards.js';

const N = Number(process.env.N ?? 400);
for (let i = 0; i < N; i++) {
  const seed = 4200 + i * 977;
  const { state, summary } = await simulateRound({ seed, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  const isTop = c =>
    c.rank === 15 || c.rank === 16 ||
    (c.rank === round.rankCard && c.suit === round.trumpSuit);
  let wasteful = 0, kills = 0;
  for (const t of hist) {
    if (t.leadSuit === 'TRUMP') continue;      // 主牌墩不算「毙」
    const n = t.plays?.[0]?.cards?.length ?? 0;
    if (n < 2) continue;                        // 单张毙没有「多交」的余地
    for (const play of (t.plays ?? []).slice(1)) {
      const cards = play.cards ?? [];
      const allTrump = cards.length === n &&
        cards.every(c => playSuitOf(c, round.trumpSuit, round.rankCard) === 'TRUMP');
      if (!allTrump) continue;
      kills += 1;
      if (cards.filter(isTop).length >= 2) wasteful += 1;
    }
  }
  console.log(JSON.stringify({ seed, grab: !!summary?.kittyGrab, kills, wasteful }));
}
