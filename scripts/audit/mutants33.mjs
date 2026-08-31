// 变异测试：Glen 2026-08-30「场上如果有 K，经常会不管后果用 A 去砍，
//   导致给对手甩 8 支 10 支的情况，自己那时还有这门牌」。
// 「快断门可以吃」这条例外得看【我毙不毙得动】，而且要按最坏情况算。
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  [F, `      (partnerAhead ||
        worstOpponentSuitLen(view, ctx, suit) <= cardsOfSuit(hand, 'TRUMP', ctx).length)`,
      '      true',
      '退回旧写法：快断门就一律可以吃，不看毙不毙得动'],
  [F, `      (partnerAhead ||
        worstOpponentSuitLen(view, ctx, suit) <= cardsOfSuit(hand, 'TRUMP', ctx).length)`,
      '      partnerAhead',
      '「断了能毙」那一半整个删掉 —— 只有队友领先才放行'],
  [F, `      (partnerAhead ||
        worstOpponentSuitLen(view, ctx, suit) <= cardsOfSuit(hand, 'TRUMP', ctx).length)`,
      `      (worstOpponentSuitLen(view, ctx, suit) <= cardsOfSuit(hand, 'TRUMP', ctx).length)`,
      '队友已经领先也不放行 —— 「只剩 K 和 3 还是要把 K 给队友」那条没了'],
  [F, "        worstOpponentSuitLen(view, ctx, suit) <= cardsOfSuit(hand, 'TRUMP', ctx).length)",
      "        maxOpponentSuitEstimate(view, ctx, suit) <= cardsOfSuit(hand, 'TRUMP', ctx).length)",
      '用期望值而不是最坏情况（期望值系统性低估，实测中位 2.6 而实战甩到 9 张）'],

  // ---- 最坏情况本身的两条上界 ----
  [F, '    worst = Math.max(worst, Math.min(outstanding, player.handCount ?? 0));',
      '    worst = Math.max(worst, outstanding);',
      '不看他手上一共几张牌 —— 残局也当成他能攥满整门'],
  [F, '    if (player.seat % 2 === view.you.team) continue;   // 队友甩这门不是威胁',
      '',
      '把队友的手牌也算成威胁'],
]);
