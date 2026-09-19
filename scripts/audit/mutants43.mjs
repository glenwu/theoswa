// 变异测试：尾盘最后一墩的赢牌，留还是砍（Glen 2026-09-19 裁定）。
//   「底给撬了，基本意味着多 20 分，而且底里边还有分可以加……还有自己能大的概率」
//   「一般情况下，还是不砍……如果能保底，这个行为就至少值 20 分」
//   「庄家的话，如果对方还没什么分，比如 50 分以内……那是不能砍的」
// ⚠️ 锚点写的是源码原文；改代码后用 MUTATE_DRY=1 重扫。
//
// 故意【没有】收的变异体（杀不掉，理由写在这里而不是假装有覆盖）：
//   · 潜在那一档去掉 survival（倒数第三墩没主护着也不打折）：gain × 底值 ≈ 5.7 → 2.9，
//     分数都是 5 的倍数，只有桌上恰好 5 分时分得出来，而且那一格也没有 Glen 的裁定可依。
//   · KEEPER_PLAYS_FIRST 从 0.3 改到 0.5：0.2 × 28.6 → 0.33 × 28.6 ≈ 9.5，同样落在 5 和 10 之间，
//     和 0.3 做出的决定一样。这个数是我定的，只钉「按概率、而且概率不大」这件事（下面改成 1 那条）。
//   · 窗口放宽到 3 张：Glen 只说了「倒数二三轮」，4 张时该不该留他没裁过。
import { runMutants } from './mutate.mjs';

const F = 'server/bot-policy.js';
runMutants([
  [F, '      score -= LAST_TRICK_KEEPER_PENALTY * bottomWeight * tuning.bottomControlWeight;',
      '      score -= 0;',
      '整条不罚：倒数二三墩照样拿大鬼去砍（Glen 报的就是这个）'],
  [F, '      kept.length >= 1 && kept.length <= 2 &&',
      '      kept.length >= 1 && kept.length <= 1 &&',
      '只管倒数第二墩，倒数第三墩不管'],
  [F, "      !kept.some(card =>\n        suitOf(card, ctx) === 'TRUMP' && cardStrength(card, ctx) >= keeper.strength\n      ) &&\n      keeperWorthKeeping(view, ctx, keeper)",
      '      keeperWorthKeeping(view, ctx, keeper)',
      '不管这一手交没交出去，所有候选一起罚（等于没罚）'],
  [F, '  const bottomValue = KITTY_GRAB_TIER_POINTS + kittyPointEstimate(view);',
      '  const bottomValue = KITTY_GRAB_TIER_POINTS;',
      '不算底里的分，只算撬底那 20'],
  [F, '  const bottomValue = KITTY_GRAB_TIER_POINTS + kittyPointEstimate(view);',
      '  const bottomValue = kittyPointEstimate(view);',
      '只算底分，撬底那一档（20）不算'],
  [F, '  if (keeper.equalOutstanding === 0) return survival * bottomValue > stake;',
      '  if (keeper.equalOutstanding === 0) return bottomValue > stake;',
      '倒数第三墩大鬼没主护着也当稳的'],
  [F, "    otherTrumps - (lead.playSuit === 'TRUMP' ? lead.cards.length : 0) >= 1 ||",
      '    otherTrumps >= 1 ||',
      '领主时跟掉的那张主也算成护着大鬼的'],
  [F, '    defenderPoints <= DEFENDER_POINTS_LOW &&',
      '    false &&',
      '庄家「对方没什么分就不砍」整条丢了（Glen 第 1 条）'],
  [F, '    defenderPoints <= DEFENDER_POINTS_LOW &&',
      '    defenderPoints < DEFENDER_POINTS_LOW &&',
      '「50 分以内」不含 50'],
  [F, '    defenderPoints + stake < DEFENDER_TARGET_POINTS\n  ) return true;',
      '    true\n  ) return true;',
      '让掉就到线了也当「没什么分」'],
  [F, '  const gain = TWIN_WITH_OPPONENT * KEEPER_PLAYS_FIRST;',
      '  const gain = 1;',
      '潜在的顶牌当成稳的（不按概率打折）'],
  [F, '  return gain * survival * bottomValue > stake;\n}',
      '  return false;\n}',
      '潜在的顶牌除了庄家那条一律砍（桌上没分也砍）'],
]);
