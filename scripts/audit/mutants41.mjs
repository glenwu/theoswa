// 变异测试：Glen 2026-09-15 求件的读法 ——
//   「队友看到你求的时候，需要假设一般情况下是两件，队友如果看到外边已经出了
//     两件（包括队友自己出的）要假设你已经可以甩了，不再为你打这个花色求件了，
//     而且队友可以转为吊主……如果队友看到了你再打这门，那要假设你是一求三。」
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  // ---- 停止条件本身 ----
  [F, '  if (partnerAsked && partnerCanThrowPresumed(view, ctx, suit, partnerSeat, first)) {',
      '  if (false) {',
      '没有停止条件 —— 件出够了还一直替他捅（Glen 报的就是这个）'],
  [F, '  return outsideBefore(history.length) >= total - Math.max(1, held);',
      '  return outsideBefore(history.length) >= total;',
      '要外边把四件全出完才算他甩得动（等于他自己一件没有）'],

  // ---- 一求三：出够之后他又领这门 ----
  [F, '    if (held > 1 && outsideBefore(i) >= total - held) held -= 1;',
      '    if (false) held -= 1;',
      '他出够之后又领这门，也不改口成一求三'],

  // ---- 我手上还压着件 ----
  [F, "  if (total === 0) return false;\n  if (items.some(item => item.status === 'mine')) return false;",
      '  if (total === 0) return false;',
      '我手上还压着这门的件，也当他甩得动（他其实甩不了）'],

  // ---- 领牌：回门 / 转吊主 / 别的意图 ----
  // 注：「他甩得动了还提回队友那门」那条变异体跟着代码一起删了 —— 领牌处那道闸
  // 和下面的删提案互相掩护（两条变异体都存活过），留了更通用的删提案那一道。
  [F, '    const partnerThrowDraw = partnerRequest(view, ctx)?.canThrow ? 480 : 0;',
      '    const partnerThrowDraw = 0;',
      '他甩得动了也不转去吊主'],
  [F, '        proposal.cards.length === 1 && partnerThrow.has(suitOf(proposal.cards[0], ctx))',
      '        false',
      '发展长副牌 / 兜底小牌照样去捅他那门'],
]);
