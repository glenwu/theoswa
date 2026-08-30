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

  // ---- 第二档「可以毙别人」：断门 + 那门场上还有 + 长主 ----
  [F, `  if (
    cardsOfSuit(hand, 'TRUMP', ctx).length > TRUMP_AVERAGE_PER_HAND &&
    SUITS.some(suit =>
      suit !== ctx.trumpSuit &&
      cardsOfSuit(hand, suit, ctx).length === 0 &&
      played.filter(card => suitOf(card, ctx) === suit).length < TOTAL_PER_SIDE_SUIT
    )
  ) return true;`, '',
      '「可以毙别人」这一档整个删掉'],
  [F, "    cardsOfSuit(hand, 'TRUMP', ctx).length > TRUMP_AVERAGE_PER_HAND &&",
      "    cardsOfSuit(hand, 'TRUMP', ctx).length > 0 &&",
      '不看是不是长主 —— 手上有一张主就算能毙别人（Glen 的线是「多过 9 张」）'],
  [F, 'const TRUMP_AVERAGE_PER_HAND = TOTAL_TRUMPS / 4;',
      'const TRUMP_AVERAGE_PER_HAND = 8;',
      '长主线降到 8（Glen 给的是 36/4 = 9，多过 9 才算）'],
  [F, "      cardsOfSuit(hand, suit, ctx).length === 0 &&",
      "      cardsOfSuit(hand, suit, ctx).length >= 0 &&",
      '不看那门断没断 —— 没断也当成能毙别人'],

  // ---- 放件门槛那张表（Glen 2026-08-30 逐档给的）----
  [F, '  const needsDraw = declarerSide && !bottomControlOf(view, ctx).guaranteed;',
      '  const needsDraw = declarerSide;',
      '庄家一方一律 30 —— 够保底了也死守（他说的是「需要吊主」才 30）'],
  [F, '  const needsDraw = declarerSide && !bottomControlOf(view, ctx).guaranteed;',
      '  const needsDraw = false;',
      '不分庄闲，一律 20 —— 庄家要保底那一条没了'],
  [F, '  const base = needsDraw ? PIECE_ASK_POINTS_DRAWING : PIECE_ASK_POINTS_BASE;',
      '  const base = PIECE_ASK_POINTS_DRAWING;',
      '闲家也用 30 那条线（闲家吃分为主，不该一样严）'],
  [F, '  if (gone >= PIECE_SUIT_GONE_PLAYED) return Math.min(base, PIECE_ASK_POINTS_SUIT_GONE);',
      '',
      '牌走光那一档没了 —— 中后期不再放宽吃分'],
  [F, '  if (gone >= PIECE_SUIT_THIN_PLAYED) return Math.min(base, PIECE_ASK_POINTS_SUIT_THIN);',
      '',
      '「那门快完了」那一档没了'],
  [F, '  if (gone >= PIECE_SUIT_GONE_PLAYED) return Math.min(base, PIECE_ASK_POINTS_SUIT_GONE);\n  if (gone >= PIECE_SUIT_THIN_PLAYED) return Math.min(base, PIECE_ASK_POINTS_SUIT_THIN);',
      '  if (gone >= PIECE_SUIT_GONE_PLAYED) return base;\n  if (gone >= PIECE_SUIT_THIN_PLAYED) return base;',
      '两档都不真的放宽（照旧用基线）'],
  [F, 'const PIECE_SUIT_GONE_PLAYED = 16;', 'const PIECE_SUIT_GONE_PLAYED = 22;',
      '「剩的不多」推到 22 张（他给的是 24 支里出了 16-18 支）'],

  // ---- 得真的是 A ----
  [F, '    if (!cards.some(card => card.rank === 14 && card.rank !== ctx.rankCard)) return false;',
      '    if (cards.length === 0) return false;',
      '随便一张副牌都算起手牌'],
]);
