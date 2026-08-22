// 审计脚本（不进主干）：真实揭牌流程中，手牌顺序是否按「鬼 + 黑梅方红 + 级牌提前」整理。
import { createInitialState, playerBySeat } from '../../server/state.js';
import { beginRound, drawOneCard } from '../../server/round.js';
import { mulberry32 } from '../../server/rng.js';
import { handGroups } from '../../client/src/handGroups.js';

const NAME = { S: '♠', C: '♣', D: '♦', H: '♥', JOKER: '鬼' };
const R = r => ({ 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '小', 16: '大' }[r] ?? String(r));
const show = c => NAME[c.suit] + R(c.rank);

const state = createInitialState(mulberry32(42));
state.declarerSeat = 0;          // 第二局起：庄家已定，直接进 REVEALING
state.phase = 'REVEALING';
beginRound(state);
state.round.rankCard = 2;
state.round.revealTurnSeat = 0;

// 逆时针摸满 100 张（没有人亮主，纯看排序）
for (let i = 0; i < 100; i++) drawOneCard(state, state.round.revealTurnSeat);

for (const seat of [0, 1]) {
  const hand = playerBySeat(state, seat).hand;
  console.log(`\n座位 ${seat}（${hand.length} 张）`);
  console.log('  ' + hand.map(show).join(' '));
  const groups = handGroups(hand, null, 2); // 主牌未定 → 揭牌口径分组
  console.log('  分组: ' + groups.map(g => `${NAME[g.suit] ?? g.suit}×${g.count}`).join(' | '));
}

// 断言：花色区间必须连续（每门只出现一段），且顺序为 鬼,S,C,D,H
let bad = 0;
for (const p of state.players) {
  const seq = p.hand.map(c => (c.suit === 'JOKER' ? 'TRUMP' : c.suit));
  const runs = [];
  for (const s of seq) if (runs.at(-1) !== s) runs.push(s);
  const expected = ['TRUMP', 'S', 'C', 'D', 'H'].filter(s => seq.includes(s));
  if (JSON.stringify(runs) !== JSON.stringify(expected)) {
    bad++;
    console.log(`\n✗ 座位 ${p.seat} 分组不连续: ${runs.join(',')} 应为 ${expected.join(',')}`);
  }
  // 级牌必须在本花色组最前
  for (const suit of ['S', 'C', 'D', 'H']) {
    const grp = p.hand.filter(c => c.suit === suit);
    const idx = grp.findIndex(c => c.rank === 2);
    if (idx > 0) { bad++; console.log(`\n✗ 座位 ${p.seat} ${NAME[suit]}2 不在本组最前（位置 ${idx}）`); }
  }
}
console.log(`\n${bad === 0 ? '✓ 四家全部符合：鬼最左、黑梅方红、级牌提到本组最前' : `✗ ${bad} 处不符`}`);
