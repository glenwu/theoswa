// 变异测试：Glen 第 3 条「件不能乱出」——「快断门」那条豁免要卡在【真的吃下这一墩】上。
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  [F, `    if (
      takesTrick &&
      cardsOfSuit(hand, suit, ctx).length - spentHere <= PIECE_NEAR_VOID_AFTER
    ) return sum;`,
      '    if (cardsOfSuit(hand, suit, ctx).length - spentHere <= PIECE_NEAR_VOID_AFTER) return sum;',
      '退回老口径：不看结果，垫牌位置也照样豁免'],
  [F, '    view, ctx, cards, partnerAskedSuit, tuning, after?.seat === you.seat',
      '    view, ctx, cards, partnerAskedSuit, tuning, afterTeamWinning',
      '只要我方赢下就算「吃」—— 队友已经稳赢时我这支件也白亮'],
  [F, '    view, ctx, cards, partnerAskedSuit, tuning, after?.seat === you.seat',
      '    view, ctx, cards, partnerAskedSuit, tuning, true',
      '恒真 = 豁免永远成立（等于没改）'],
  [F, '    view, ctx, cards, partnerAskedSuit, tuning, after?.seat === you.seat',
      '    view, ctx, cards, partnerAskedSuit, tuning, false',
      '恒假 = 快断门这条豁免整个失效（Glen 明说过的例外被抹掉）'],
]);
