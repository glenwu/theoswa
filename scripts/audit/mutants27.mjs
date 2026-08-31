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
  // ⚠️ 2026-08-30 起门槛不再是常数，按【角色 × 要不要吊主 × 这门还剩多少】查表
  // （Glen 给的），判断也挪进了按门循环。那张表的变异体在 mutants30。
  [F, '    if (tablePoints >= pieceAskPointsFor(view, ctx, suit)) continue;',
      '    if (tablePoints >= 10) continue;',
      '门槛降到 10 分 —— 正是 Glen 点名的那一档'],
  [F, '    if (tablePoints >= pieceAskPointsFor(view, ctx, suit)) continue;',
      '',
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
  // ⚠️ 2026-08-29 闸扩到了【除队友求以外的所有门】（Glen：「不管对手有没有求，
  // 件还是不能乱出……件在情况不明的状态不能乱出」），条件从 !== 'opponent'
  // 变成 === 'partner'。
  [F, "    if (suitAskSignal(view, ctx, suit) === 'partner') continue;",
      '    if (false) continue;',
      '队友求的件也一起挡 —— Glen：对家有表示可以很没压力地出件'],
  [F, "    if (suitAskSignal(view, ctx, suit) === 'partner') continue;",
      "    if (suitAskSignal(view, ctx, suit) !== 'opponent') continue;",
      '退回旧范围：只挡对手求的门，情况不明的门照旧乱出'],

  // ---- 「有两件可以砍」 ----
  [F, "    if (items.filter(item => item.status === 'mine').length >= 2) continue;",
      "    if (items.filter(item => item.status === 'mine').length >= 1) continue;",
      '一件也算「有两件」—— 整道闸等于没有'],

  // ---- 「即使对方甩了也得不了多少分，那么就可以杀」 ----
  // ⚠️ 判据 2026-08-29 换过：从 suitPointsAtLarge（这门还剩多少分）换成
  // sideSuitTotalPoints（这门天生多少分）。Glen 纠正：甩牌的价值不局限在这一门，
  // 「这门的分被打掉了」不算安全，只有打 10 / 打 K 那种结构性少分才算。
  [F, '    if (sideSuitTotalPoints(ctx) <= PIECE_COVER_MIN_POINTS) continue;',
      '    if (false) continue;',
      '打 K 时这门天生少 20 分也照挡 —— 把 Glen 那条例外挡掉了'],
  [F, '    if (sideSuitTotalPoints(ctx) <= PIECE_COVER_MIN_POINTS) continue;',
      '    if (sideSuitTotalPoints(ctx) <= 50) continue;',
      '门槛放到满分 —— 一般局也算「天生刮不到分」'],
  [F, '    if (sideSuitTotalPoints(ctx) <= PIECE_COVER_MIN_POINTS) continue;',
      '    if (suitPointsAtLarge(view, ctx, suit) <= PIECE_COVER_MIN_POINTS) continue;',
      '退回旧判据：这门的分被打掉了就算安全（Glen 说那是算漏了）'],

  // ---- 「或是自己没剩多少如三支甚至两支」 ----
  // ⚠️ 「快断门」那条例外 2026-08-30 加了前提（毙得动 / 队友领先），判断挪进了
  // 一个多行的 if。那两个前提的变异体在 mutants33。
  [F, '      cardsOfSuit(hand, suit, ctx).length - spentHere <= PIECE_NEAR_VOID_AFTER &&',
      '      cardsOfSuit(hand, suit, ctx).length - spentHere <= 4 &&',
      '「快断了」放宽到剩 4 张 —— 长门也算快断'],
  [F, '      cardsOfSuit(hand, suit, ctx).length - spentHere <= PIECE_NEAR_VOID_AFTER &&',
      '      false &&',
      '快断门也照挡 —— Glen 的原例（♠A ♠9 ♠6 打 A）会打不出来'],

  // ---- 件全现了就没有风险可言 ----
  [F, "    if (!items.some(item => item.status === 'unseen')) continue;",
      '    if (false) continue;',
      '件全现完了还挡着 —— 那是白护'],
]);
