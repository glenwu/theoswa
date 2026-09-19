// 变异测试：只剩【大鬼 + 一张副牌】时不兑现大鬼（Glen 2026-09-19，倒数二三墩别把大鬼撞出来）。
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  [F, '    bigJoker &&\n    nonTrumps.length > 1 &&',
      '    bigJoker &&\n    nonTrumps.length > 0 &&',
      '大鬼 + 一张副牌也兑现（改之前）'],
  [F, '    bigJoker &&\n    nonTrumps.length > 1 &&',
      '    bigJoker &&\n    nonTrumps.length > 2 &&',
      '大鬼 + 两张副牌也不兑现了（越界改了 Glen 原来那条裁定）'],
]);
