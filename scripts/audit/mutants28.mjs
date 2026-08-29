// 变异测试：Glen 2026-08-29 场景乙的裁定 ——
//   件不是我方喂的时候默认【不去压】（求别的门更好，这门已经挡不住了），
//   例外是他求出件之后不甩、转打主 = 在留甩尾手，那就要去捅短。
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  // ---- 例外要真的存在 ----
  [F, `    const throwReady =
      (owed || opponentSavingTailThrow(view, ctx, threatSuit)) &&
      opponentThrowReadyIn(view, ctx, threatSuit);`,
      '    const throwReady = owed && opponentThrowReadyIn(view, ctx, threatSuit);',
      '退回旧写法：只认我方喂过件，他留甩尾手也不去捅'],
  [F, `    const throwReady =
      (owed || opponentSavingTailThrow(view, ctx, threatSuit)) &&
      opponentThrowReadyIn(view, ctx, threatSuit);`,
      '    const throwReady = opponentThrowReadyIn(view, ctx, threatSuit);',
      '场景乙一律去压 —— Glen 说默认该去求别的门'],

  // ---- 判据：求完不能又回来打这门 ----
  [F, "    if (trick.leadSuit === suit) return false;            // 又回来打这门 = 没在留",
      '',
      '他又回来打这门也算「留着甩尾手」'],
  // ---- 判据：得真的转打主 ----
  [F, "    if (trick.leadSuit === 'TRUMP') drewTrump = true;\n  }\n  return drewTrump;",
      "    if (trick.leadSuit === 'TRUMP') drewTrump = true;\n  }\n  return true;",
      '不看有没有转打主，求过件就算留尾巴'],
  // ---- 判据：只看对手自己领的 ----
  [F, '    if (trick.leadSeat % 2 === view.you.team) continue;   // 只看对手自己领的',
      '',
      '我方领的主牌也算成「他转打主」'],
  // ---- 得先是对手在求 ----
  [F, "  if (suitAskSignal(view, ctx, suit) !== 'opponent') return false;",
      '  if (false) return false;',
      '队友求的门也当成他在留甩尾手'],

  // ---- 挂钩点：这门得先进得了威胁门候选 ----
  [F, `  for (const suit of SUITS.filter(item => item !== ctx.trumpSuit)) {
    if (!opponentSavingTailThrow(view, ctx, suit)) continue;
    scores.set(suit, (scores.get(suit) ?? 0) + tuning.opponentThreatThreshold);
  }`, '',
      '留尾巴的门不算威胁门 —— 他只求过一次的话根本进不了候选'],
]);
