// 变异测试：Glen「不得以或是砍大分出的话，就要再吊对手可以甩花色」——
// 件喂出去之后从「躲这门」翻成「压这门」。
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  [F, '    !teamGavePieceIn(view, ctx, suit)   // 已经交出去了就别再躲，见下',
      '    true',
      '件交出去之后还接着躲这门（躲了也没用了）'],
  [F, `  for (const suit of SUITS.filter(item => item !== ctx.trumpSuit)) {
    if (!teamGavePieceIn(view, ctx, suit)) continue;
    scores.set(suit, (scores.get(suit) ?? 0) + tuning.opponentThreatThreshold);
  }`, '',
      '交出去之后也不主动去压，还得等他领够两次'],
  [F, "      (owed ? 400 : 250) * tuning.leadStrategyPriorWeight,",
      '      250 * tuning.leadStrategyPriorWeight,',
      '欠着的那门不再单独一档 —— 被「发展自己最长的门」(360) 盖回去'],
  [F, "      (owed ? 400 : 250) * tuning.leadStrategyPriorWeight,",
      '      400 * tuning.leadStrategyPriorWeight,',
      '不欠也照 400 打 —— 把普通的压缩提案一起抬上去'],
  [F, "    if (trick.leadSeat % 2 === view.you.team) continue;          // 得是对手在求",
      '',
      '队友求件、我方贡献件也算「被迫喂给对手」'],
  [F, '    if (!isPieceRequestLead(trick.plays?.[0]?.cards ?? [], ctx)) continue;\n    const gave = (trick.plays ?? []).some(play =>',
      '    const gave = (trick.plays ?? []).some(play =>',
      '对手随便领这门、我方出了件也算（不限于他在求件）'],
  [F, '      play.seat % 2 === view.you.team &&',
      '      play.seat % 2 !== view.you.team &&',
      '判反：看的是对手自己出了件'],
]);
