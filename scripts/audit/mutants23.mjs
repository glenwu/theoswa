// 变异测试：Glen「不能帮对方吊主，除非自己的主牌碾压式的强」。
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  [F, '  if (!opening && !helpingOpponentDraw && drawPool.length > 0 && outstandingTrumps > 0 &&',
      '  if (!opening && drawPool.length > 0 && outstandingTrumps > 0 &&',
      '照旧跟着对手吊主'],
  [F, '  const helpingOpponentDraw = opponentDrawingTrumps(view) && !crushingTrumps;',
      '  const helpingOpponentDraw = opponentDrawingTrumps(view);',
      '主牌碾压时也不许反吊（例外没了）'],
  [F, '  const helpingOpponentDraw = opponentDrawingTrumps(view) && !crushingTrumps;',
      '  const helpingOpponentDraw = !crushingTrumps;',
      '不看是谁吊的 —— 队友吊过也不跟'],
  [F, '    control.holdsTopTrump && trumps.length > maxOpponentTrumpEstimate(view, ctx);',
      '    trumps.length > maxOpponentTrumpEstimate(view, ctx);',
      '「碾压」不再要求顶端在手（只比张数）'],
  [F, '    return history[i].leadSeat % 2 !== view.you.team;',
      '    return history[i].leadSeat % 2 === view.you.team;',
      '判反：躲的是队友吊过的主'],
]);
