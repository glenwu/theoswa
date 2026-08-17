import { playSuitOf, cardPoints, SUITS } from './cards.js';

// 碾压收尾：判定“A 队将赢下剩余全部轮次”的充分条件（宁可漏检，绝不误判）。
// 同时满足三条才成立：
//   1. B 队两人手上没有任何主牌（含大鬼/小鬼/主级牌/副级牌/主花色牌）；
//   2. 对每一门 A 队持有的副牌花色 S：B 队该门无牌自动满足；
//      否则 A 队在 S 上的最小牌 > B 队在 S 上的最大牌（必须严格大于）。
//      A 队不持有的花色 A 永远不会领出，无需比较；
//   3. 当前领出方（leadSeat）属于 A 队。
//
// 证明：A 领出任意牌（必为其持有的花色），B 有该花色也压不过（条件2）、
// 没有该花色又杀不了（条件1），本轮必归 A；A 赢后继续领出，归纳成立。
// 三条缺一不可——若领出方是 B，B 可以领出自己的强花色，结论不成立。
export function checkDominance(state) {
  const r = state.round;
  // PLAYING 或 CROSS_RIVER（过河换牌后、进入出牌前也要判定——用换牌之后的手牌）
  if (!r || !(state.phase === 'PLAYING' || state.phase === 'CROSS_RIVER') || !r.trumpSuit) return null;
  if (r.lastTrick || r.currentTrick.length > 0) return null; // 只在轮次间隙判定
  const ctx = { trumpSuit: r.trumpSuit, rankCard: r.rankCard };
  const isTrump = c => playSuitOf(c, ctx.trumpSuit, ctx.rankCard) === 'TRUMP';
  const suitOf = c => playSuitOf(c, ctx.trumpSuit, ctx.rankCard);
  const teamCards = t => state.players.filter(p => p.team === t).flatMap(p => p.hand);
  const leadTeam = r.leadSeat % 2;
  const perHand = state.players[0].hand.length; // 手牌数不变量保证四家相等

  for (const team of [0, 1]) {
    const B = teamCards(1 - team);
    const A = teamCards(team);
    if (A.length === 0) continue; // 没有剩余手牌，无需判定
    if (B.some(isTrump)) continue; // 条件1：对方还有主牌 → 不成立
    let ok = true;
    for (const s of SUITS) {
      if (s === ctx.trumpSuit) continue;
      const aCards = A.filter(c => suitOf(c) === s);
      if (aCards.length === 0) continue; // A 不持有该门 → 永远不会领出，无需比较
      const bCards = B.filter(c => suitOf(c) === s);
      if (bCards.length === 0) continue; // B 该门无牌 → 自动满足
      const minA = Math.min(...aCards.map(c => c.rank));
      const maxB = Math.max(...bCards.map(c => c.rank));
      if (!(minA > maxB)) { ok = false; break; } // 必须严格大于（等于也不行）
    }
    if (!ok) continue;
    if (leadTeam !== team) continue; // 条件3：领出方必须是 A 队
    const remainingCards = [...A, ...B];
    const remainingPoints = remainingCards.reduce((sum, c) => sum + cardPoints(c), 0);
    return {
      winningTeam: team,
      remainingTricks: perHand,
      remainingPoints,
      pointsToDefender: team !== state.declarerSeat % 2,
      kittyGrab: team !== state.declarerSeat % 2, // 最后一轮赢家为 A 队 → 据此判定撬底
    };
  }
  return null;
}
