// Glen 实战反馈：庄家首轮「带分吊主」求大鬼，队友已经应了「不用吊主」，
// 庄家却还在吊，一路吊到手上只剩两个鬼。
//
// 量三件事：
//   1. 应答之后庄家还领了几轮主（这是要压下去的数）
//   2. 庄家吊主领出的牌按档次分布（鬼 / 主级牌应当接近 0）
//   3. 应答的两种形态各出现多少次
import { simulateRound } from '../../server/simulate-bots.js';
import { cardPoints } from '../../server/cards.js';

const N = Number(process.env.N ?? 40);
let signalRounds = 0, byJoker = 0, bySideLead = 0, drawsAfterAnswer = 0;
const earlyDraws = [], lateDraws = [];
const drawTiers = { 大鬼: 0, 小鬼: 0, 主级牌: 0, 副级牌: 0, 主花色: 0 };

for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: 4200 + i * 977, difficulty: 'expert' });
  const round = state?.round;
  if (!round) continue;
  const hist = (round.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  const ctx = { trumpSuit: round.trumpSuit, rankCard: round.rankCard };
  const dec = round.trumpEvent?.declarerSeat ?? round.declarerSeat;
  if (dec === null || dec === undefined) continue;
  const partner = (dec + 2) % 4;
  const tierOf = card =>
    card.rank === 16 ? '大鬼' : card.rank === 15 ? '小鬼'
    : card.rank === ctx.rankCard ? (card.suit === ctx.trumpSuit ? '主级牌' : '副级牌')
    : '主花色';

  for (const t of hist) {
    if (t.leadSeat !== dec || t.leadSuit !== 'TRUMP') continue;
    for (const c of t.plays?.[0]?.cards ?? []) drawTiers[tierOf(c)] += 1;
  }

  const first = hist[0];
  if (first.leadSeat !== dec || first.leadSuit !== 'TRUMP') continue;
  if (!(first.plays?.[0]?.cards ?? []).some(c => cardPoints(c) > 0)) continue;
  signalRounds += 1;

  const ans = (first.plays ?? []).find(p => p.seat === partner);
  const jokerAnswer = (ans?.cards ?? []).some(c => c.rank === 15 || c.rank === 16);
  // 应答之后庄家还吊了几轮：从「应答成立的那一墩」之后开始数
  let answeredAt = jokerAnswer ? 0 : -1;
  if (answeredAt < 0) {
    const idx = hist.findIndex((t, k) => k > 0 && t.leadSeat === partner && t.leadSuit !== 'TRUMP');
    answeredAt = idx;
  }
  if (answeredAt < 0) continue;
  jokerAnswer ? (byJoker += 1) : (bySideLead += 1);
  hist.forEach((t, k) => {
    if (k <= answeredAt || t.leadSeat !== dec || t.leadSuit !== 'TRUMP') return;
    drawsAfterAnswer += 1;
    // 手上只剩主牌时领主不算「吊主」，是没得选。用「本局最后 8 墩」当代理指标。
    (k >= hist.length - 8 ? lateDraws : earlyDraws).push(k + 1);
  });
}

console.log(`共 ${N} 局，庄家首轮带分吊主 ${signalRounds} 局`);
console.log(`  队友应答：用鬼吃 ${byJoker} 局 / 转领副牌 ${bySideLead} 局`);
console.log(`应答之后庄家仍吊主合计 ${drawsAfterAnswer} 轮`);
console.log(`  其中中前段（离收官还有 8 墩以上）${earlyDraws.length} 轮，收官前 8 墩 ${lateDraws.length} 轮`);
console.log(`庄家吊主领出的牌按档次：`, drawTiers);
