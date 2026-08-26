// 变异测试：Glen 第三次强调的「留鬼保底/撬底，不能见牌或见分就砍」。
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  // ---- 出鬼的代价不再按手牌张数开关 ----
  [F, '  if (jokersSpent.length > 0) {',
      '  if (early && jokersSpent.length > 0) {',
      '退回老口径：手牌 ≤8 张（后半盘）就不再罚 —— 保底比的恰恰是最后一墩'],
  [F, '  if (jokersSpent.length > 0) {',
      '  if (false && jokersSpent.length > 0) {',
      '出鬼完全没有代价'],
  [F, '    score -= Math.max(0, cost * 2.2 - totalPoints * 8) * settings.controlReserve * controlCaution;',
      '    score -= Math.max(0, cost * 2.2) * settings.controlReserve * controlCaution;',
      '分再大也不肯砍（把「够分就该砍」那一半抹掉）'],

  // ---- 「这一下把底丢了」不再只认副牌墩的毙 ----
  [F, `  if (
    afterDefenderPoints < DEFENDER_TARGET_POINTS &&
    bottomControlOf(view, ctx).holdsTopTrump &&
    !bottomControlAfter(view, ctx, cards).holdsTopTrump
  ) {`,
      `  if (
    isKill &&
    afterDefenderPoints < DEFENDER_TARGET_POINTS &&
    bottomControlOf(view, ctx).holdsTopTrump &&
    !bottomControlAfter(view, ctx, cards).holdsTopTrump
  ) {`,
      '退回 isKill 那道闸 —— 首家领主牌时 isKill 恒为 false，最常见的场面漏在外面'],
]);
