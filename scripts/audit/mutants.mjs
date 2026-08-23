// 审计 1.4：变异测试 —— 往关键纯函数里植入真实 bug，看测试是否变红。
// 活下来的变异体 = 那行代码没有任何测试盯着（改错了不会有人发现）。
import { runMutants } from './mutate.mjs';

runMutants([
  // ---- 计分（规则核心）----
  ['server/scoring.js', 'P_final >= DEFENDER_TARGET_POINTS', 'P_final > DEFENDER_TARGET_POINTS', '撬底档位边界 80 分'],
  ['server/scoring.js', 'Math.floor((P_final - DEFENDER_TARGET_POINTS) / 20) + 1',
   'Math.floor((P_final - DEFENDER_TARGET_POINTS) / 20)', '撬底档位 +1 级'],
  ['server/scoring.js', 'last.winnerSeat % 2 !== state.declarerSeat % 2', 'last.winnerSeat % 2 === state.declarerSeat % 2', '撬底判定取反'],
  // ---- 跟牌合法性 ----
  ['server/trick.js', 'if (mySuitCount >= N)', 'if (mySuitCount > N)', '「手里够 N 张就必须全跟」的边界'],
  ['server/trick.js', 'if (playedSuitCount !== N)', 'if (playedSuitCount > N)', '必须跟满 N 张'],
  ['server/trick.js', 'if (playedSuitCount !== mySuitCount)', 'if (playedSuitCount > mySuitCount)', '花色不够时必须全打出、不许留'],
  ['server/trick.js', 'if (cards.length !== N)', 'if (cards.length > N)', '跟牌张数必须等于 N'],
  ['server/trick.js', 'if (suits.size !== 1)', 'if (suits.size > 2)', '甩牌必须同花色'],
  ['server/trick.js', 'best = Math.max(best, cardStrength(c, ctx))', 'best = Math.min(best === -Infinity ? cardStrength(c, ctx) : best, cardStrength(c, ctx))', '比大小取最大 → 取最小'],
  // ---- 碾压收尾 ----
  ['server/dominance.js', 'if (r.currentTrick.length > 0) return null;', 'if (r.currentTrick.length >= 0) return null;', '碾压判定被守卫掐死（历史真 bug 重演）'],
  // ---- 保密裁剪 ----
  ['server/viewer.js', 'handCount: Array.isArray(p.hand) ? p.hand.length : 0,', 'handCount: Array.isArray(p.hand) ? p.hand.length : 0,\n      composition: ownComposition(p.hand ?? [], ctx),', '把每个人的花色构成下发给所有人（非 Card 形状，扫描器看不见）'],
  ['server/viewer.js', "'round.trickHistory',", "'round.trickHistory', 'players',", '白名单开一个 players 口子'],
  // ---- 件 / 甩牌资格 ----
  ['server/pieces.js', "p.location.kind === 'hand'", "p.location.kind === 'kittyRevealed'", '主牌甩牌「谁挡得住」的判定来源'],
  // ---- 手牌展示（客户端纯逻辑）----
  ['client/src/handGroups.js', 'group.count >= 5', 'group.count > 5', '组张数角标门槛 5'],
  ['client/src/handGroups.js', 'const val = Math.max(dp[r - 1][j], spanW(j, i));', 'const val = dp[r - 1][j] + spanW(j, i);', '分行目标从「最宽行最窄」变成「总宽最小」（退化成任意划分）'],
  ['client/src/handGroups.js', 'if (R === 1) return [[0, n]];', 'if (R === 1) return [[0, n]];\n  widths = widths.map(() => 1);', '按元素个数均分，忽略实际宽度（旧的错误做法）'],
  // ---- 级别 / 轮转 ----
  ['server/rotation.js', '(seat + 3) % SEAT_COUNT', '(seat + 1) % SEAT_COUNT', '轮转方向反了'],
  // ---- 顶栏空窗期（Glen 实测：小结确认完后第X局/级牌回退）----
  ['server/viewer.js', 'nextRound: upcomingRound(state),',
   'nextRound: { roundNumber: 1, rankCard: 2 },', '空窗期顶栏又退回「第1局/打2」'],
  ['server/round.js', 'const { roundNumber, rankCard } = upcomingRound(state);',
   'const roundNumber = state.rounds.length + 1;\n  const rankCard = 2;',
   'beginRound 不再和 upcomingRound 共用一份（级牌两处各算一遍）'],
]);
