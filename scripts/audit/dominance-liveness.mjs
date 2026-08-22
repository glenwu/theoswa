// 审计脚本（不进主干）：验证「每一轮结算之后」的碾压检测是否真的会触发。
// 文档 §6.7.1：检测在每一轮结算之后执行。
import { applyAction } from '../../server/actions.js';
import { createInitialState, createRoundState, playerBySeat } from '../../server/state.js';
import { rebuildPieces } from '../../server/pieces.js';
import { checkDominance } from '../../server/dominance.js';

const C = (id, suit, rank) => ({ id, suit, rank });

// 主=♥，打2。座位 0/2 = A 队，1/3 = B 队。庄家 0。
// 每人 2 张。第 1 轮结束后：A 队(0,2) 手上全是主牌，B 队(1,3) 一张主牌都没有，
// 且第 1 轮由 A 队赢下 → leadSeat 属于 A 队 → 碾压三条件全部成立。
function build() {
  const s = createInitialState(() => 0.5);
  s.declarerSeat = 0;
  s.phase = 'PLAYING';
  const r = createRoundState(1, 0);
  r.trumpSuit = 'H';
  r.rankCard = 2;
  r.kitty = [];
  r.leadSeat = 0;
  r.turnSeat = 0;
  s.round = r;

  // 第 1 轮打♠，A 队用大牌赢；第 2 轮起 A 队手上只剩主牌，B 队只剩小副牌
  playerBySeat(s, 0).hand = [C('a0', 'S', 14), C('a1', 'H', 16)];      // ♠A + 大鬼(主)
  playerBySeat(s, 1).hand = [C('b0', 'S', 3), C('b1', 'C', 4)];        // 全副牌
  playerBySeat(s, 2).hand = [C('a2', 'S', 13), C('a3', 'H', 15)];      // ♠K + 小鬼(主)
  playerBySeat(s, 3).hand = [C('b2', 'S', 5), C('b3', 'C', 6)];        // 全副牌
  rebuildPieces(s);
  return s;
}

const s = build();
const order = [0, 3, 2, 1]; // 逆时针
const ids = order.map(seat => playerBySeat(s, seat).id);
const cards = ['a0', 'b2', 'a2', 'b0'];

for (let i = 0; i < 4; i++) {
  const res = applyAction(s, { type: 'play', cardIds: [cards[i]] }, ids[i]);
  if (!res.ok) { console.log(`出牌失败 seat=${order[i]}: ${res.error.reason}`); process.exit(1); }
}

const winner = s.round.trickHistory[0].winnerSeat;
console.log(`第 1 轮赢家 seat=${winner}（${winner % 2 === 0 ? 'A 队' : 'B 队'}），leadSeat=${s.round.leadSeat}`);
console.log(`第 1 轮结算后各家手牌：`);
for (const p of [...s.players].sort((a, b) => a.seat - b.seat)) {
  console.log(`  seat${p.seat}(${p.team === 0 ? 'A' : 'B'}) = ${p.hand.map(c => c.suit + c.rank).join(',')}`);
}

console.log(`\n实际 phase = ${s.phase}`);
console.log(`r.lastTrick 是否已被置上 = ${!!s.round.lastTrick}`);
console.log(`handlePlay 里那次 checkDominance 的返回 = ${JSON.stringify(checkDominance(s))}`);

// 把 lastTrick 清掉（模拟收牌停留结束）再判一次，看条件本身到底成不成立
s.round.lastTrick = null;
const afterSettle = checkDominance(s);
console.log(`清掉 lastTrick 后再判 = ${JSON.stringify(afterSettle)}`);

console.log(`\n结论：碾压条件${afterSettle ? '成立' : '不成立'}；`
  + `而每轮结算处实际${s.phase === 'DOMINANCE' ? '触发了' : '**没有触发**'}。`);
