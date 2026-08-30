// 变异测试：Glen 2026-08-30 描述的「甩尾手」条件③ —— 起手牌不止大鬼那一档。
//   「需要有起手牌，就是甩牌的前一轮需要保证大，通常大鬼是比较好的，其次可以毙
//     别人，也可以是副牌的 A（前提是这门牌没怎么打，大家都还有）。」
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  // ---- 起手牌整条 ----
  [F, '    if (!tailThrowEntry(view, ctx, control, suit)) continue;  // 条件③：起手牌',
      '',
      '不看有没有起手牌，能甩的长门一律当成甩尾手计划'],
  [F, '  if (control.holdsTopTrump) return true;',
      '  return control.holdsTopTrump;',
      '退回旧写法：只认顶端主牌那一档，副 A 那一档没了'],

  // ---- 「必须在要甩的那门之外」 ----
  [F, "    if (suit === ctx.trumpSuit || suit === throwSuit) return false;",
      "    if (suit === ctx.trumpSuit) return false;",
      '起手牌可以就在要甩的那门里 —— 那张牌是甩牌的一部分，赢不了「前一轮」'],

  // ---- 「这门没怎么打，大家都还有」 ----
  [F, '    return gone <= TAIL_ENTRY_SUIT_PLAYED_MAX;',
      '    return true;',
      '不看这门打掉多少 —— 别人早断门了 A 也当成保证大'],
  [F, 'const TAIL_ENTRY_SUIT_PLAYED_MAX = 8;',
      'const TAIL_ENTRY_SUIT_PLAYED_MAX = 24;',
      '门槛放到满门（等于这个前提失效）'],

  // ---- 得真的是 A ----
  [F, '    if (!cards.some(card => card.rank === 14 && card.rank !== ctx.rankCard)) return false;',
      '    if (cards.length === 0) return false;',
      '随便一张副牌都算起手牌'],
]);
