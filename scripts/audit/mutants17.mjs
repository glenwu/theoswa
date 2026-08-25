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

  // ---- 求件的意图跨墩有效 ----
  [F, '    if (trick.leadSeat !== partnerSeat || trick.leadSuit === \'TRUMP\') continue;\n    if (!isPieceAskLead(trick.plays?.[0]?.cards ?? [], ctx)) continue;',
      '    if (trick.leadSeat !== partnerSeat || trick.leadSuit === \'TRUMP\') continue;\n    if (!isPieceAskLead(trick.plays?.[0]?.cards ?? [], ctx)) break;',
      '队友最近一领不是求件就放弃 —— 退回「只看最近一次」的老毛病'],
  [F, "    if (!items.some(item => item.status === 'unseen')) break; // 逼完了",
      '',
      '件已经全现了还在接着逼（该甩的时候还在一张张领）'],
  [F, "    if (!items.some(item => item.status === 'unseen')) break; // 逼完了",
      "    if (items.some(item => item.status === 'unseen')) break; // 逼完了",
      '判反：只在件已经逼完时才去帮忙'],
  [F, '    if (!holdsCards(suit)) break;                             // 这门我打空了',
      '',
      '这门自己一张都没有了还惦记着去逼'],
  [F, '      seeking: true,\n      partnerIsDeclarer: partnerSeat === view.declarerSeat,\n    };\n  }\n\n  // ============ ② 没有未了的求件：回队友最近领的那门 ============',
      '      seeking: false,\n      partnerIsDeclarer: partnerSeat === view.declarerSeat,\n    };\n  }\n\n  // ============ ② 没有未了的求件：回队友最近领的那门 ============',
      '未了的求件不再算「明确求件」，力度掉回普通回门'],
]);
