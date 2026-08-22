// 变异测试：大鬼「压制」彩蛋。
import { runMutants } from './mutate.mjs';
const A = 'server/actions.js';
const C = 'server/constants.js';
runMutants([
  [A, '    beatenSeat !== null &&', '', '领出大鬼也算压制（首家的 beatenSeat 为 null）'],
  [A, '    winsNow &&', '', '被碰出来的大鬼也算压制'],
  [A, '    !isLastTrick &&', '', '最后一轮也弹'],
  [A, "playedCards.some(c => c.rank === 16)", "playedCards.some(c => c.rank >= 15)", '小鬼也算大鬼'],
  [A, 'const victim = r.currentTrick.find(p => p.seat === beatenSeat);', 'const victim = r.currentTrick.find(p => p.seat === me.seat);', '回嘴挂错人（挂到打大鬼的人身上）'],
  [A, 'const beatenEgg = suppresses\n    ? rollSuppressedEgg(state.niiRandom ?? Math.random)\n    : null;', 'const beatenEgg = null;', '被压制方永远不回嘴'],
  [A, 'const pudiao = suppresses && (state.niiRandom ?? Math.random)() < 0.8;', 'const pudiao = suppresses;', '「谱掉你」不掷骰，必弹'],
  [C, '  { id: \'nieyige\', text: \'捏一个吉\', chance: 0.2 },', '  { id: \'nieyige\', text: \'捏一个吉\', chance: 0.9 },', '第一段概率改成 0.9'],
  [C, '    if (random() < egg.chance) return egg.text;\n  }\n  return null;', '    if (random() < egg.chance) return egg.text;\n  }\n  return SUPPRESSED_EGGS[0].text;', '三掷全不中也硬弹一句'],
  [C, 'for (const egg of SUPPRESSED_EGGS) {', 'for (const egg of [...SUPPRESSED_EGGS].reverse()) {', '判定顺序反过来'],
]);
