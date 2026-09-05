// 变异测试：Glen 2026-09-06「三求一……BOT 队友基本没有看到回应过」。
// 求件的阶梯补上「领件」那一档之后，读信号（suitAskSignal）和不乱发信号
//（straySignal）这两头都得钉住。
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  // ---- 读信号：谁在求这门 ----
  [F, '  if (!first || !isPieceAskLead(first.cards, ctx)) return null;',
      '  if (!first || !isPieceRequestLead(first.cards, ctx)) return null;',
      '退回只认小牌那一档 —— 别人领件求件读不出来'],

  // ---- 不乱发信号：手上只有一支件还领出去 = 假三求一 ----
  [F, '  const fakePieceAsk = isSidePiece(card, ctx) && piecesHere <= 1;',
      '  const fakePieceAsk = false;',
      '假求件那条整条删掉（孤件照领，队友白交件）'],
  [F, '  const fakePieceAsk = isSidePiece(card, ctx) && piecesHere <= 1;',
      '  const fakePieceAsk = isSidePiece(card, ctx);',
      '不看手上有几件 —— 真三求一（两件以上）也被当成乱求'],
]);
