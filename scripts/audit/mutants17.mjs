// 变异测试：Glen 第 2 条「帮队友把件逼出来」，以及统一后的求件判据。
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  // ---- 求件判据（全项目唯一那一份）----
  [F, '    isPieceRequestLead(cards, ctx) ||\n    (isSidePiece(card, ctx) && cardPoints(card) > 0)',
      '    isPieceRequestLead(cards, ctx)',
      '领副 K 不再算「强烈求 A」'],
  [F, '    isPieceRequestLead(cards, ctx) ||\n    (isSidePiece(card, ctx) && cardPoints(card) > 0)',
      '    !isSidePiece(card, ctx) || cardPoints(card) > 0',
      '退回那个最松的老判据（任何非件小牌都算求件）'],

  // ---- 队友最近一领 = 他现在的计划（换门 / 改吊主就作废）----
  [F, "  if (!last || last.leadSuit === 'TRUMP') return null;",
      '  if (!last) return null;',
      '队友改吊主也当成「回他这门」，跟着去领主牌'],
  [F, '  if (cardsOfSuit(view.you.hand ?? [], suit, ctx).length === 0) return null;',
      '',
      '队友那门我一张都没有了还惦记着去回（lowestLead 拿到空数组）'],

  // ---- 同门跨墩：他换成非求件牌接着打这门，第一次那个求件仍然算数 ----
  [F, `    for (let i = lastIndex; i >= 0; i -= 1) {
      const trick = history[i];
      if (trick.leadSeat !== partnerSeat || trick.leadSuit !== suit) continue;
      if (!isPieceAskLead(trick.plays?.[0]?.cards ?? [], ctx)) continue;
      return { suit, seeking: true, partnerIsDeclarer };
    }`, '',
      '跨墩记忆整段删掉 —— 只认他最近一领是不是求件牌'],
  [F, '      if (trick.leadSeat !== partnerSeat || trick.leadSuit !== suit) continue;',
      '      if (trick.leadSeat !== partnerSeat) continue;',
      '跨墩不再限定同一门 —— 换了门也回去逼旧那门（Glen 裁定这是错的）'],
  [F, "  if (items.some(item => item.status === 'unseen')) {",
      '  if (true) {',
      '件已经全现了还在接着逼（该甩的时候还在一张张领）'],
  [F, '      return { suit, seeking: true, partnerIsDeclarer };',
      '      return { suit, seeking: false, partnerIsDeclarer };',
      '未了的求件不再算「明确求件」，力度掉回普通回门'],
]);
