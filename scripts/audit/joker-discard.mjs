// 复核 Glen 的实战反馈②：「我方甩一门牌后，BOT 把这门牌下完，然后贴其它门牌
// 的时候放了小鬼在里边，也不是给逼出来的」。
//
// 判据只用公开信息：副牌墩里，一手牌既不是【满额跟花色】也不是【满额主牌毙】，
// 就永远参与不了比大小（server/trick.js trickLeader 分支 A）—— 那这手就是纯垫牌。
// 垫牌里出现鬼 = 白扔。再按「这门牌他跟了几张」分开看：
//   混合垫  —— 跟了几张花色 + 拿鬼来凑张数（Glen 说的那个形状）
//   全垫    —— 这门一张没有，整手垫出去，里边夹着鬼
import { simulateRound } from '../../server/simulate-bots.js';
import { playSuitOf } from '../../server/cards.js';

const N = Number(process.env.N ?? 400);
let tricks = 0, discards = 0, mixed = 0, mixedJoker = 0, fullJoker = 0, throwJoker = 0;

for (let i = 0; i < N; i++) {
  const { state } = await simulateRound({ seed: 4200 + i * 977, difficulty: 'expert' });
  const round = state?.round;
  const hist = (round?.trickHistory ?? []).filter(t => !t.virtual);
  if (!hist.length) continue;
  const { trumpSuit, rankCard } = round;
  const ps = card => playSuitOf(card, trumpSuit, rankCard);

  for (const t of hist) {
    const plays = t.plays ?? [];
    const lead = plays[0];
    if (!lead) continue;
    const leadSuit = lead.playSuit ?? ps(lead.cards[0]);
    if (leadSuit === 'TRUMP') continue;
    const n = lead.cards.length;
    tricks += 1;
    for (const play of plays.slice(1)) {
      const suitCards = play.cards.filter(c => ps(c) === leadSuit);
      const trumps = play.cards.filter(c => ps(c) === 'TRUMP');
      if (suitCards.length === n || trumps.length === n) continue; // 参与比大小，不是垫牌
      discards += 1;
      const jokers = play.cards.filter(c => c.rank === 15 || c.rank === 16).length;
      if (suitCards.length > 0) {
        mixed += 1;
        if (jokers > 0) { mixedJoker += jokers; if (n > 1) throwJoker += jokers; }
      } else if (jokers > 0) fullJoker += jokers;
    }
  }
}

console.log(`${N} 局，副牌墩 ${tricks} 墩，其中赢不了的垫牌手 ${discards} 手\n`);
console.log(`混合垫（跟了几张花色 + 凑张数）  ${mixed} 手，里边夹着鬼 ${mixedJoker} 张`);
console.log(`  └ 其中对手是【甩牌】的         ${throwJoker} 张`);
console.log(`全垫（这门一张没有）             里边夹着鬼 ${fullJoker} 张`);
