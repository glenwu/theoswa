// 变异测试：Glen 2026-08-29「对手求的件不能随手砍出去」那道硬闸。
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  // ---- 闸本身 ----
  [F, `  const sparing = choices.filter(choice => !pieceOwedToOpponentAsk(view, ctx, choice.cards));
  const pool = sparing.length > 0 ? sparing : choices;

  return pool`,
      '  return choices',
      '整道闸删掉 —— 退回「对手求的件，见分就砍」'],
  [F, '  const pool = sparing.length > 0 ? sparing : choices;',
      '  const pool = sparing;',
      '兜底删掉 —— 全部候选都得交件时返回空手（真人局里直接卡死）'],

  // ---- 「除非有大分，比如 20 分以上」 ----
  [F, '  if (tablePoints >= PIECE_ASK_BIG_POINTS) return false;',
      '  if (tablePoints >= 10) return false;',
      '门槛降到 10 分 —— 正是 Glen 点名的那一档'],
  [F, '  if (tablePoints >= PIECE_ASK_BIG_POINTS) return false;',
      '  if (false) return false;',
      '大分也不许砍 —— 把 Glen 给的例外挡掉了'],
  [F, `  const tablePoints = (view.round?.currentTrick ?? [])
    .flatMap(play => play.cards ?? [])
    .reduce((sum, card) => sum + cardPoints(card), 0);`,
      `  const tablePoints = (view.round?.currentTrick ?? [])
    .flatMap(play => play.cards ?? [])
    .reduce((sum, card) => sum + cardPoints(card), 0) +
    cards.reduce((sum, card) => sum + cardPoints(card), 0);`,
      '把我自己这支 K 的 10 分也算成奖品 —— 拿自己付的钱凑门槛'],

  // ---- 「只管对手在求的门」 ----
  [F, "    if (suitAskSignal(view, ctx, suit) !== 'opponent') continue;",
      "    if (suitAskSignal(view, ctx, suit) === null) continue;",
      '队友求的件也一起挡 —— Glen：对家有表示可以很没压力地出件'],
  [F, "    if (suitAskSignal(view, ctx, suit) !== 'opponent') continue;",
      '    if (false) continue;',
      '不看是谁求的，谁求都挡'],

  // ---- 「有两件可以砍」 ----
  [F, "    if (items.filter(item => item.status === 'mine').length >= 2) continue;",
      "    if (items.filter(item => item.status === 'mine').length >= 1) continue;",
      '一件也算「有两件」—— 整道闸等于没有'],

  // ---- 「即使对方甩了也得不了多少分，那么就可以杀」 ----
  [F, '    if (suitPointsAtLarge(view, ctx, suit) <= PIECE_COVER_MIN_POINTS) continue;',
      '    if (false) continue;',
      '这门刮不到分也照挡 —— 把 Glen 那条例外挡掉了'],
  [F, '    if (suitPointsAtLarge(view, ctx, suit) <= PIECE_COVER_MIN_POINTS) continue;',
      '    if (suitPointsAtLarge(view, ctx, suit) <= 50) continue;',
      '门槛放到满分 —— 任何时候都算「刮不到分」'],

  // ---- 「或是自己没剩多少如三支甚至两支」 ----
  [F, '    if (cardsOfSuit(hand, suit, ctx).length - spentHere <= PIECE_NEAR_VOID_AFTER) continue;',
      '    if (cardsOfSuit(hand, suit, ctx).length - spentHere <= 4) continue;',
      '「快断了」放宽到剩 4 张 —— 长门也算快断'],
  [F, '    if (cardsOfSuit(hand, suit, ctx).length - spentHere <= PIECE_NEAR_VOID_AFTER) continue;',
      '    if (false) continue;',
      '快断门也照挡 —— Glen 的原例（♠A ♠9 ♠6 打 A）会打不出来'],

  // ---- 件全现了就没有风险可言 ----
  [F, "    if (!items.some(item => item.status === 'unseen')) continue;",
      '    if (false) continue;',
      '件全现完了还挡着 —— 那是白护'],
]);
