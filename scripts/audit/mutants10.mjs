// 变异测试：场上已打出统计 + 座位状态文案。
import { runMutants } from './mutate.mjs';
const P = 'client/src/playedCounts.js';
const S = 'client/src/seatStatus.js';
runMutants([
  [P, '    ...(round.currentTrick ?? []),', '', '不统计当前这一墩'],
  [P, '    ...(round.trickHistory ?? []).flatMap(trick => trick.plays ?? []),', '', '不统计历史轮次'],
  [P, "      if (card.rank === 16) out.bigJoker += 1;", "      if (card.rank === 15) out.bigJoker += 1;", '大鬼小鬼数反了'],
  [P, "if (playSuitOf(card, round.trumpSuit, round.rankCard) === 'TRUMP') out.trump += 1;\n      else out[card.suit] += 1;",
      "out[card.suit] = (out[card.suit] ?? 0) + 1;", '不按主/副分类，一律按原花色计'],
  [P, '    trump: trumpSuit ? 36 : 0,', '    trump: trumpSuit ? 34 : 0,', '主牌总数写错'],
  [P, '    S: 24, H: 24, D: 24, C: 24,', '    S: 26, H: 26, D: 26, C: 26,', '副牌总数忘了扣掉级牌'],
  [S, "      if (!round?.flipDone) return null;", '', '牌还没翻出来就显示「未准备」'],
  [S, "      return round.flipConfirms?.includes(player.seat) ? '已准备✓' : '未准备';",
      "      return '已准备✓';", '起揭停留时所有人都显示已准备'],
  [S, "      return round?.roundEndConfirms?.includes(player.seat) ? '已看完✓' : '看小结中';",
      '      return null;', '本局小结不显示谁看完了'],
  [S, "    case 'READY_CHECK':\n      return player.ready ? '已准备✓' : '未准备';", "    case 'READY_CHECK':\n      return null;", '准备阶段不显示准备状态'],
  [S, '    default:\n      return null;', "    default:\n      return '等待中';", '所有阶段都硬凑一句文案'],
]);
